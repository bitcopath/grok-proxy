/**
 * Minimal MCP (Model Context Protocol) surface for grok-proxy.
 *
 * Hand-rolled streamable-HTTP JSON-RPC endpoint (POST /mcp) exposing Grok's
 * Imagine media generation as MCP tools — no SDK dependency:
 *   - grok_imagine_image  → grok with image_gen/image_edit tools
 *   - grok_imagine_video  → still image, then image_to_video animation
 *
 * Generated files land in DATA_DIR and are returned as HTTP URLs served by
 * the proxy's own /files/<name> route, so off-box clients (DSH, agents on
 * other machines) can actually fetch them.
 *
 * Supported methods: initialize, ping, tools/list, tools/call.
 * Notifications (no id) get 202 with no body. Batch requests are rejected.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_TIMEOUT_MS = parseInt(process.env.GROK_MEDIA_TIMEOUT_MS, 10) || 600000;

const TOOLS = [
  {
    name: 'grok_imagine_image',
    description: 'Generate or edit a still image with Grok Imagine. Returns HTTP URLs of the generated files.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate (or how to edit)' },
        ratio: { type: 'string', description: 'Aspect ratio hint, e.g. "1:1", "16:9"' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'grok_imagine_video',
    description: 'Generate a short video clip with Grok Imagine (still image, then animation). Returns HTTP URLs of the generated files.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Clip description / motion' },
        duration: { type: 'number', description: 'Seconds (default 6)' },
        resolution: { type: 'string', description: '480p or 720p (default 480p)' }
      },
      required: ['prompt']
    }
  }
];

const MEDIA_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm'];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

function toolText(id, text, isError = false) {
  return rpcResult(id, { content: [{ type: 'text', text }], isError });
}

function extractMediaPaths(text, dataDir) {
  const found = new Set();
  const re = /(?:\/[\w.\-]+)+\.(png|jpe?g|webp|gif|mp4|mov|webm)/gi;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const abs = m[0];
    // Only expose files that really exist under DATA_DIR (no traversal, no host leaks)
    const resolved = path.resolve(abs);
    if (resolved.startsWith(path.resolve(dataDir) + path.sep) && fs.existsSync(resolved)) {
      found.add(path.basename(resolved));
    }
  }
  return [...found];
}

function createMcpHandler({ runGrok, logger, version }) {
  async function callImagine(requestId, name, args, host) {
    const prompt = (args && args.prompt || '').trim();
    if (!prompt) {
      return { error: 'prompt is required' };
    }

    let fullPrompt;
    let tools;
    let maxTurns;
    if (name === 'grok_imagine_image') {
      const ratio = args.ratio ? ` Aspect ratio: ${args.ratio}.` : '';
      fullPrompt = `Generate an image: ${prompt}.${ratio} Save the file into the current working directory. Reply with the absolute file path(s) of the generated file(s).`;
      tools = 'image_gen,image_edit';
      maxTurns = 4;
    } else {
      const duration = Math.min(Math.max(parseInt(args.duration, 10) || 6, 1), 15);
      const resolution = String(args.resolution || '480p') === '720p' ? '720p' : '480p';
      fullPrompt = `Create a short video clip: ${prompt}. First generate a still image, then animate it into a video. Duration: ${duration}s. Resolution: ${resolution}. Save the file into the current working directory. Reply with the absolute file path(s) of the generated file(s).`;
      tools = 'image_gen,image_to_video';
      maxTurns = 6;
    }

    logger.info({
      requestId,
      type: 'mcp_imagine_start',
      tool: name,
      promptLength: fullPrompt.length
    }, `[${requestId}] MCP ${name} started`);

    let result;
    try {
      result = await runGrok(fullPrompt, null, requestId, {
        tools,
        maxTurns,
        timeoutMs: MEDIA_TIMEOUT_MS,
        cwd: DATA_DIR
      });
    } catch (error) {
      logger.error({ requestId, type: 'mcp_imagine_error', tool: name, error: error.message },
        `[${requestId}] MCP ${name} failed: ${error.message}`);
      return { error: `generation failed: ${error.message}` };
    }

    const files = extractMediaPaths(result.response, DATA_DIR);
    if (!files.length) {
      logger.warn({ requestId, type: 'mcp_imagine_no_files', tool: name },
        `[${requestId}] MCP ${name} produced no parseable files`);
      return { error: 'generation finished but no media file was found in the output' };
    }

    const urls = files.map((f) => `http://${host}/files/${encodeURIComponent(f)}`);
    logger.info({ requestId, type: 'mcp_imagine_done', tool: name, files },
      `[${requestId}] MCP ${name} done: ${files.join(', ')}`);

    return {
      text: JSON.stringify({
        files: urls,
        tool: name,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd
      }, null, 2)
    };
  }

  async function handleMcp(req, res, requestId, data) {
    const host = req.headers.host || 'localhost';

    // Notifications (no id) → accepted, no response body
    if (data && data.id === undefined && typeof data.method === 'string') {
      res.writeHead(202);
      res.end();
      return;
    }

    if (!data || typeof data.method !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(data && data.id, -32600, 'invalid JSON-RPC request')));
      return;
    }

    const { id, method, params } = data;

    switch (method) {
      case 'initialize':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'grok-proxy', version }
        })));
        return;

      case 'ping':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcResult(id, {})));
        return;

      case 'tools/list':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcResult(id, { tools: TOOLS })));
        return;

      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some((t) => t.name === name)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(toolText(id, `unknown tool: ${name}`, true)));
          return;
        }
        const outcome = await callImagine(requestId, name, params.arguments || {}, host);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          outcome.error ? toolText(id, outcome.error, true) : toolText(id, outcome.text)
        ));
        return;
      }

      default:
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcError(id, -32601, `method not found: ${method}`)));
    }
  }

  return { handleMcp };
}

module.exports = { createMcpHandler };
