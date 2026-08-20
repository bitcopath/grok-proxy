/**
 * OpenAI-compatible /v1 surface for grok-proxy.
 *
 * Translates chat-completions requests into headless Grok Build CLI runs:
 *   - Stateless: the full messages array is flattened into one prompt per call.
 *   - Brain-only: restricted tools + --max-turns 1 + --no-subagents; the model
 *     must never execute anything on behalf of the caller.
 *   - tool_calls translation via grok's native --json-schema constrained output
 *     (oneOf: final text | tool_calls), so no fragile prompt parsing.
 *   - model "local-qwen" forwards the request untouched to the local
 *     OpenAI-compatible server (LOCAL_AI_BASE_URL) — free path.
 *   - Optional Bearer auth when PROXY_API_KEY is set.
 *
 * No new dependencies — wired into server.js's existing runGrok().
 */

const MODEL_ID = process.env.GROK_V1_MODEL || 'grok-build';
const LOCAL_MODEL = 'local-qwen';
const API_KEY = process.env.PROXY_API_KEY || '';
const LOCAL_AI_BASE_URL = process.env.LOCAL_AI_BASE_URL || '';
const LOCAL_AI_MODEL = process.env.LOCAL_AI_MODEL || 'local-qwen';
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 300000;

const BRAIN_RULES = 'You are the backend of an OpenAI-compatible chat API. ' +
  'You have no tools of your own: never run commands, never claim to have ' +
  'executed anything, never invent tool output. Answer the last message of ' +
  'the transcript. When an AVAILABLE TOOLS section is present, obey the JSON ' +
  'output schema exactly.';

// ============================================================================
// Message flattening (OpenAI messages -> transcript prompt)
// ============================================================================

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && p.type === 'text') return p.text || '';
      if (p && p.type === 'image_url') return '[image omitted: not supported by this endpoint]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content);
}

function flattenMessages(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      parts.push('[system]\n' + textOf(m.content));
    } else if (m.role === 'user') {
      parts.push('[user]\n' + textOf(m.content));
    } else if (m.role === 'assistant') {
      let block = '[assistant]\n' + textOf(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        block += '\n[assistant tool_calls]\n' + m.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return `${fn.name || 'unknown'}(${fn.arguments || '{}'})`;
        }).join('\n');
      }
      parts.push(block);
    } else if (m.role === 'tool') {
      parts.push(`[tool result: ${m.name || m.tool_call_id || 'tool'}]\n` + textOf(m.content));
    }
  }
  return parts.join('\n\n');
}

function buildPrompt(messages, tools) {
  let prompt = flattenMessages(messages);
  if (Array.isArray(tools) && tools.length) {
    prompt += '\n\nAVAILABLE TOOLS (JSON schemas):\n' + JSON.stringify(tools);
    prompt += '\n\nIf the request needs a tool, respond with the tool_calls variant of the schema; otherwise the final variant.';
  }
  prompt += '\n\n[assistant]\n';
  return prompt;
}

// ============================================================================
// JSON-schema contract for --json-schema (grok constrained output)
// ============================================================================

function contractSchema() {
  return {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['final'] },
          content: { type: 'string' }
        },
        required: ['type', 'content'],
        additionalProperties: false
      },
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['tool_calls'] },
          calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                arguments: { type: 'object' }
              },
              required: ['name', 'arguments'],
              additionalProperties: false
            }
          }
        },
        required: ['type', 'calls'],
        additionalProperties: false
      }
    ]
  };
}

function parseContract(raw) {
  const text = (raw || '').trim();
  if (!text) return { content: '' };
  try {
    const obj = JSON.parse(text);
    if (obj && obj.type === 'tool_calls' && Array.isArray(obj.calls)) {
      const toolCalls = obj.calls
        .filter((c) => c && c.name)
        .map((c, i) => ({
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: String(c.name),
            arguments: typeof c.arguments === 'string'
              ? c.arguments
              : JSON.stringify(c.arguments || {})
          }
        }));
      if (toolCalls.length) return { toolCalls };
    }
    if (obj && obj.type === 'final' && typeof obj.content === 'string') {
      return { content: obj.content };
    }
  } catch {
    // fall through
  }
  return { content: text }; // graceful degradation
}

// ============================================================================
// Handler factory (wired with server.js's runGrok)
// ============================================================================

function createV1Handler({ runGrok, readLocalApiKey, logger }) {
  function authorized(req) {
    if (!API_KEY) return true;
    return (req.headers.authorization || '') === `Bearer ${API_KEY}`;
  }

  function modelsPayload() {
    const now = Math.floor(Date.now() / 1000);
    const data = [{ id: MODEL_ID, object: 'model', created: now, owned_by: 'grok-proxy' }];
    if (LOCAL_AI_BASE_URL) {
      data.push({ id: LOCAL_MODEL, object: 'model', created: now, owned_by: 'local' });
    }
    return { object: 'list', data };
  }

  function openaiError(message, type = 'invalid_request_error', code = null) {
    return { error: { message, type, param: null, code } };
  }

  function sseHeaders(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
  }

  function sseSend(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function chunkPayload(id, model, delta, finishReason) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
  }

  // ---- local-qwen: transparent forward to the local OpenAI-compatible server
  async function handleLocalQwen(req, res, requestId, data) {
    const url = `${LOCAL_AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: LOCAL_AI_MODEL,
      messages: data.messages,
      stream: data.stream === true
    };
    if (data.temperature != null) body.temperature = data.temperature;
    if (data.max_tokens != null) body.max_tokens = data.max_tokens;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROK_TIMEOUT_MS);
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readLocalApiKey()}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!upstream.ok) {
        const raw = await upstream.text();
        throw new Error(`local AI HTTP ${upstream.status}: ${raw.substring(0, 300)}`);
      }

      if (data.stream === true) {
        // Pass the upstream SSE stream through untouched
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        for await (const chunk of upstream.body) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      const json = await upstream.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    } catch (error) {
      logger.error({ requestId, type: 'v1_local_error', error: error.message },
        `[${requestId}] local-qwen forward failed: ${error.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiError(`local backend error: ${error.message}`, 'server_error')));
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- grok brain
  async function handleGrokChat(req, res, requestId, data) {
    const tools = Array.isArray(data.tools) && data.tools.length ? data.tools : null;
    const wantStream = data.stream === true;
    const prompt = buildPrompt(data.messages, tools);
    const completionId = `chatcmpl-${requestId}`;

    logger.info({
      requestId,
      type: 'v1_chat_request',
      messageCount: data.messages.length,
      hasTools: !!tools,
      toolCount: tools ? tools.length : 0,
      stream: wantStream,
      promptLength: prompt.length
    }, `[${requestId}] /v1/chat/completions (msgs: ${data.messages.length}, tools: ${tools ? tools.length : 0}, stream: ${wantStream})`);

    let result;
    const contentParts = [];

    if (tools) {
      // Contract mode: constrained JSON output, buffered (no incremental SSE)
      if (wantStream) sseHeaders(res);
      try {
        result = await runGrok(prompt, null, requestId, {
          maxTurns: 1,
          permissionMode: 'dontAsk',
          extraArgs: [
            '--json-schema', JSON.stringify(contractSchema()),
            '--rules', BRAIN_RULES,
            '--no-subagents'
          ]
        });
      } catch (error) {
        return sendGrokError(res, requestId, wantStream, error, logger);
      }
    } else if (wantStream) {
      // Plain chat with SSE: stream Anthropic-wire deltas.
      sseHeaders(res);
      let wholeMessageText = '';
      const onLine = (obj) => {
        if (!obj) return;
        // Incremental delta (with --include-partial-messages)
        if (obj.type === 'stream_event' && obj.event &&
            obj.event.type === 'content_block_delta' &&
            obj.event.delta && obj.event.delta.type === 'text_delta' &&
            typeof obj.event.delta.text === 'string') {
          contentParts.push(obj.event.delta.text);
          sseSend(res, chunkPayload(completionId, MODEL_ID, { content: obj.event.delta.text }, null));
          return;
        }
        // Whole assistant message (kept as fallback if no deltas arrive)
        if (obj.type === 'assistant' && obj.message &&
            Array.isArray(obj.message.content)) {
          wholeMessageText = obj.message.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
        }
      };
      try {
        result = await runGrok(prompt, null, requestId, {
          maxTurns: 1,
          streamMessages: true,
          permissionMode: 'dontAsk',
          onLine,
          extraArgs: ['--rules', BRAIN_RULES, '--no-subagents']
        });
      } catch (error) {
        return sendGrokError(res, requestId, wantStream, error, logger);
      }
      if (!contentParts.length && wholeMessageText) {
        contentParts.push(wholeMessageText);
        sseSend(res, chunkPayload(completionId, MODEL_ID, { content: wholeMessageText }, null));
      }
    } else {
      // Plain non-stream chat: final JSON output, clean text + usage
      try {
        result = await runGrok(prompt, null, requestId, {
          maxTurns: 1,
          permissionMode: 'dontAsk',
          extraArgs: ['--rules', BRAIN_RULES, '--no-subagents']
        });
      } catch (error) {
        return sendGrokError(res, requestId, wantStream, error, logger);
      }
    }

    let content;
    let toolCalls = null;
    let usage = result.usage || null;

    if (tools) {
      const parsed = parseContract(result.response);
      if (parsed.toolCalls) {
        toolCalls = parsed.toolCalls;
        content = null;
      } else {
        content = parsed.content;
      }
    } else {
      content = contentParts.length ? contentParts.join('') : (result.response || '');
    }

    logger.info({
      requestId,
      type: 'v1_chat_response',
      contentLength: content ? content.length : 0,
      toolCalls: toolCalls ? toolCalls.map((t) => t.function.name) : null,
      totalCostUsd: result.totalCostUsd
    }, `[${requestId}] /v1/chat/completions done (tool_calls: ${toolCalls ? toolCalls.length : 0})`);

    if (wantStream) {
      if (tools) {
        const delta = toolCalls
          ? { role: 'assistant', tool_calls: toolCalls }
          : { role: 'assistant', content };
        sseSend(res, chunkPayload(completionId, MODEL_ID, delta, null));
      }
      sseSend(res, chunkPayload(completionId, MODEL_ID, {}, toolCalls ? 'tool_calls' : 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const completion = {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }]
    };
    if (usage && usage.input_tokens != null) {
      completion.usage = {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion));
  }

  function sendGrokError(res, requestId, wantStream, error, loggerRef) {
    (loggerRef || logger).error({ requestId, type: 'v1_chat_error', error: error.message },
      `[${requestId}] /v1/chat/completions failed: ${error.message}`);
    if (wantStream) {
      sseSend(res, openaiError(`backend error: ${error.message}`, 'server_error'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiError(`backend error: ${error.message}`, 'server_error')));
    }
  }

  async function handleChat(req, res, requestId, data) {
    const messages = data.messages;
    if (!Array.isArray(messages) || !messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiError('messages must be a non-empty array')));
      return;
    }
    const model = (data.model || MODEL_ID).toLowerCase();
    if (model === LOCAL_MODEL || model === 'local' || model === 'qwen') {
      if (!LOCAL_AI_BASE_URL) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openaiError('local-qwen not configured on this proxy', 'invalid_request_error', 'model_not_available')));
        return;
      }
      await handleLocalQwen(req, res, requestId, data);
      return;
    }
    await handleGrokChat(req, res, requestId, data);
  }

  return { authorized, modelsPayload, handleChat, MODEL_ID };
}

module.exports = { createV1Handler };
