/**
 * Grok Proxy
 * HTTP → Grok Build CLI → JSON response.
 * Also supports an optional local OpenAI-compatible fallback (e.g. local Qwen).
 */

const http = require('http');
const { spawn } = require('child_process');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================
const SERVICE_VERSION = '3.1.0';
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, 'logs');
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 300000;
const GROK_PERMISSION_MODE = process.env.GROK_PERMISSION_MODE || 'bypassPermissions';
const GROK_MAX_TURNS = process.env.GROK_MAX_TURNS || '8';
const LOCAL_AI_BASE_URL = process.env.LOCAL_AI_BASE_URL || '';
const LOCAL_AI_MODEL = process.env.LOCAL_AI_MODEL || 'local-qwen';
const LOCAL_AI_API_KEY_FILE = process.env.LOCAL_AI_API_KEY_FILE || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_SENSITIVE = process.env.LOG_SENSITIVE === 'true';

// ============================================================================
// Logging
// ============================================================================
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
const logFile = path.join(LOGS_DIR, `grok-proxy-${new Date().toISOString().split('T')[0]}.log`);

const logger = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'grok-proxy', version: SERVICE_VERSION }
}, pino.multistream([
  { stream: process.stdout },
  { stream: fs.createWriteStream(logFile, { flags: 'a' }) }
]));

logger.info({ logFile, sensitiveLogging: LOG_SENSITIVE }, 'Grok proxy started logging');

// ============================================================================
// Resolve Grok binary
// ============================================================================
function resolveGrokBin() {
  const candidates = [
    process.env.GROK_BIN,
    '/usr/local/bin/grok',
    path.join(process.env.HOME || '/root', '.grok/bin/grok')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const st = fs.statSync(candidate);
        if (st.isFile() || st.isSymbolicLink()) {
          return candidate;
        }
      }
    } catch {
      // continue
    }
  }
  return 'grok';
}

const GROK_BIN = resolveGrokBin();

function grokEnv() {
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const parts = basePath.split(':').filter(Boolean);
  if (!parts.includes('/usr/local/bin')) {
    parts.unshift('/usr/local/bin');
  }
  return {
    ...process.env,
    PATH: parts.join(':'),
    HOME: process.env.HOME || '/root',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb'
  };
}

logger.info({ grokBin: GROK_BIN }, `Resolved Grok binary: ${GROK_BIN}`);

function readLocalApiKey() {
  if (LOCAL_AI_API_KEY_FILE && fs.existsSync(LOCAL_AI_API_KEY_FILE)) {
    return fs.readFileSync(LOCAL_AI_API_KEY_FILE, 'utf8').trim();
  }
  return 'local';
}

// ============================================================================
// Request tracking
// ============================================================================
class RequestTracker {
  constructor() {
    this.counter = 0;
  }
  next() {
    return `req_${Date.now()}_${++this.counter}`;
  }
}
const tracker = new RequestTracker();

// ============================================================================
// Run Grok CLI
// ============================================================================
function runGrok(prompt, sessionId, requestId, options = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = [];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    args.push('-p', prompt);
    if (options.streamMessages) {
      // Anthropic-wire NDJSON stream (deltas consumed via options.onLine)
      args.push('--output-format', 'streaming-messages-json');
      args.push('--include-partial-messages');
    } else {
      args.push('--output-format', 'json');
    }
    args.push('--permission-mode', options.permissionMode || GROK_PERMISSION_MODE);
    args.push('--no-auto-update');

    if (options.model) {
      args.push('-m', options.model);
    }

    const maxTurns = options.maxTurns || GROK_MAX_TURNS;
    args.push('--max-turns', String(maxTurns));

    if (options.tools) {
      args.push('--tools', options.tools);
    }

    // Extra CLI flags (e.g. ['--json-schema', schema] for the /v1 contract mode)
    if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
      args.push(...options.extraArgs);
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    logger.info({
      requestId,
      type: 'grok_start',
      grokBin: GROK_BIN,
      promptLength: prompt.length,
      sessionId: sessionId || null,
      hasSession: !!sessionId,
      model: options.model || null,
      tools: options.tools || null,
      maxTurns,
      ...(LOG_SENSITIVE ? { fullPrompt: prompt, args } : {})
    }, `[${requestId}] Starting Grok CLI (${prompt.length} chars, session: ${sessionId || 'none'})`);

    const grok = spawn(GROK_BIN, args, {
      cwd: DATA_DIR,
      env: grokEnv()
    });

    let output = '';
    let stderr = '';
    let firstDataTime = null;
    let lineBuf = '';

    grok.stdout.on('data', (d) => {
      if (!firstDataTime) firstDataTime = Date.now();
      const chunk = d.toString();
      output += chunk;

      // NDJSON line callback for streaming consumers (the /v1 surface)
      if (options.onLine) {
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (line) {
            try {
              options.onLine(JSON.parse(line));
            } catch {
              // non-JSON line — ignore
            }
          }
        }
      }
      logger.debug({
        requestId,
        type: 'grok_stdout_chunk',
        chunkLength: chunk.length,
        ...(LOG_SENSITIVE ? { chunk: chunk.substring(0, 500) } : {})
      }, `[${requestId}] stdout chunk (${chunk.length} chars)`);
    });

    grok.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      logger.warn({
        requestId,
        type: 'grok_stderr',
        chunkLength: chunk.length,
        ...(LOG_SENSITIVE ? { chunk: chunk.substring(0, 300) } : {})
      }, `[${requestId}] stderr (${chunk.length} chars)`);
    });

    const timeoutMs = options.timeoutMs || GROK_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      grok.kill();
      reject(new Error(`Grok timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    grok.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - start;
      const timeToFirstData = firstDataTime ? firstDataTime - start : null;

      logger.info({
        requestId,
        type: 'grok_complete',
        exitCode: code,
        durationMs: duration,
        timeToFirstDataMs: timeToFirstData,
        outputLength: output.length,
        stderrLength: stderr.length,
        sessionId: sessionId || null,
        ...(LOG_SENSITIVE ? { fullOutput: output, stderr } : {})
      }, `[${requestId}] Grok complete in ${duration}ms`);

      let parsed = null;
      let responseText = output.trim();
      let usage = null;
      let modelUsage = null;
      let totalCostUsd = null;
      let returnedSessionId = sessionId || null;
      let stopReason = null;

      const trimmed = output.trim();
      if (trimmed) {
        const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const candidate = JSON.parse(lines[i]);
            if (candidate && (candidate.text !== undefined || candidate.type === 'error' || candidate.usage)) {
              parsed = candidate;
              break;
            }
          } catch {
            // continue
          }
        }
        if (!parsed) {
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // leave as plain text
          }
        }
      }

      if (parsed) {
        if (parsed.type === 'error') {
          reject(new Error(parsed.message || 'Grok returned error object'));
          return;
        }
        if (typeof parsed.text === 'string') {
          responseText = parsed.text;
        }
        usage = parsed.usage || null;
        modelUsage = parsed.modelUsage || null;
        totalCostUsd = parsed.total_cost_usd != null ? parsed.total_cost_usd : null;
        returnedSessionId = parsed.sessionId || returnedSessionId;
        stopReason = parsed.stopReason || null;
      }

      if (code !== 0 && !responseText) {
        reject(new Error(`Grok exited with code ${code}: ${stderr || output}`));
        return;
      }
      if (code !== 0 && responseText) {
        logger.warn({
          requestId,
          type: 'grok_nonzero_with_output',
          exitCode: code,
          stderr
        }, `[${requestId}] Non-zero exit but returning output`);
      }

      logger.info({
        requestId,
        type: 'grok_response',
        responseLength: responseText.length,
        usage,
        totalCostUsd,
        sessionId: returnedSessionId,
        ...(LOG_SENSITIVE ? { responseText } : {})
      }, `[${requestId}] Final response (${responseText.length} chars)`);

      resolve({
        response: responseText,
        sessionId: returnedSessionId,
        usage,
        modelUsage,
        totalCostUsd,
        stopReason,
        provider: 'grok',
        durationMs: duration
      });
    });

    grok.on('error', (error) => {
      clearTimeout(timeout);
      logger.error({
        requestId,
        type: 'grok_error',
        error: error.message
      }, `[${requestId}] Grok process error: ${error.message}`);
      reject(error);
    });
  });
}

// ============================================================================
// Optional local model fallback
// ============================================================================
async function runLocalQwen(prompt, requestId, options = {}) {
  if (!LOCAL_AI_BASE_URL) {
    throw new Error('LOCAL_AI_BASE_URL not configured');
  }

  const start = Date.now();
  const apiKey = readLocalApiKey();
  const model = options.model || LOCAL_AI_MODEL;
  const url = `${LOCAL_AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature != null ? options.temperature : 0.3
  };

  if (options.imagePath && fs.existsSync(options.imagePath)) {
    const b64 = fs.readFileSync(options.imagePath).toString('base64');
    const ext = path.extname(options.imagePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
        : 'image/png';
    body.messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
      ]
    }];
  }

  logger.info({
    requestId,
    type: 'local_start',
    url,
    model,
    promptLength: prompt.length,
    hasImage: !!options.imagePath
  }, `[${requestId}] Starting local model`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    const duration = Date.now() - start;

    if (!res.ok) {
      throw new Error(`Local AI HTTP ${res.status}: ${raw.substring(0, 500)}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Local AI non-JSON response: ${raw.substring(0, 300)}`);
    }

    const responseText = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || null;

    logger.info({
      requestId,
      type: 'local_complete',
      durationMs: duration,
      usage,
      responseLength: responseText.length,
      ...(LOG_SENSITIVE ? { responseText } : {})
    }, `[${requestId}] Local model complete in ${duration}ms`);

    return {
      response: responseText,
      sessionId: null,
      usage,
      modelUsage: null,
      totalCostUsd: 0,
      stopReason: data.choices?.[0]?.finish_reason || null,
      provider: 'local-qwen',
      durationMs: duration
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// OpenAI-compatible /v1 surface (see openai.js)
// ============================================================================
const { createV1Handler } = require('./openai');
const v1 = createV1Handler({ runGrok, readLocalApiKey, logger });

// ============================================================================
// MCP media surface (see mcp.js)
// ============================================================================
const { createMcpHandler } = require('./mcp');
const mcp = createMcpHandler({ runGrok, logger, version: SERVICE_VERSION });

// ============================================================================
// HTTP server
// ============================================================================
const server = http.createServer(async (req, res) => {
  const requestId = tracker.next();
  const startTime = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqPath = (req.url || '').split('?')[0];

  // Generated media files (from MCP imagine tools) — path-traversal safe
  if (reqPath.startsWith('/files/') && req.method === 'GET') {
    const name = decodeURIComponent(reqPath.slice('/files/'.length));
    const safe = path.basename(name); // strips any directory components
    const full = path.join(DATA_DIR, safe);
    if (!safe || safe !== name || !fs.existsSync(full)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const ext = path.extname(safe).toLowerCase();
    const mime = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // OpenAI-compatible surface: GET /v1/models
  if (reqPath === '/v1/models' && req.method === 'GET') {
    if (!v1.authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v1.modelsPayload()));
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'grok-proxy',
      version: SERVICE_VERSION,
      grokBin: GROK_BIN,
      grokBinExists: GROK_BIN === 'grok' ? null : fs.existsSync(GROK_BIN),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      logFile,
      localAiConfigured: !!LOCAL_AI_BASE_URL,
      providers: ['grok', ...(LOCAL_AI_BASE_URL ? ['local-qwen', 'local'] : [])]
    }));
    return;
  }

  if (req.url === '/providers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      providers: {
        grok: {
          description: 'Grok Build CLI via Super Grok membership (web search, tools, strong reasoning). Uses quota.',
          cost: 'membership quota'
        },
        'local-qwen': {
          description: 'Free local OpenAI-compatible model (drafts, simple vision). No cloud quota.',
          cost: 'free (electricity / VRAM only)',
          baseUrl: LOCAL_AI_BASE_URL || null
        }
      },
      tip: 'Prefer local-qwen for cheap drafts/summaries; use grok when you need web search, harder reasoning, or membership features.'
    }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      logger.info({
        requestId,
        type: 'http_request',
        method: req.method,
        url: req.url,
        bodyLength: body.length,
        ...(LOG_SENSITIVE ? { fullBody: body } : {})
      }, `[${requestId}] HTTP ${req.method} ${req.url} (${body.length} chars)`);

      const data = JSON.parse(body);

      // MCP endpoint (initialize / tools/list / tools/call)
      if (reqPath === '/mcp') {
        if (!v1.authorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: data && data.id != null ? data.id : null, error: { code: -32001, message: 'invalid API key' } }));
          return;
        }
        await mcp.handleMcp(req, res, requestId, data);
        return;
      }

      // OpenAI-compatible chat completions → headless Grok brain (or local model)
      if (reqPath === '/v1/chat/completions') {
        if (!v1.authorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }));
          return;
        }
        await v1.handleChat(req, res, requestId, data);
        return;
      }

      const provider = (data.provider || 'grok').toLowerCase();
      const sessionId = data.sessionId || null;
      const imagePath = data.imagePath || null;

      let prompt = data.prompt;
      if (!prompt) {
        logger.error({ requestId, type: 'missing_prompt' }, 'Missing prompt');
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing prompt' }));
        return;
      }

      if (imagePath) {
        const resolved = path.isAbsolute(imagePath)
          ? imagePath
          : path.join(DATA_DIR, imagePath);
        prompt = `${prompt}\n\n[Image file path: ${resolved}]`;
      }

      logger.info({
        requestId,
        type: 'request_received',
        promptLength: prompt.length,
        provider,
        sessionId,
        hasSession: !!sessionId,
        imagePath,
        model: data.model || null,
        tools: data.tools || null,
        ...(LOG_SENSITIVE ? { fullPrompt: prompt } : {})
      }, `[${requestId}] Request (provider: ${provider}, session: ${sessionId || 'none'})`);

      let result;
      if (provider === 'local' || provider === 'local-qwen' || provider === 'qwen') {
        result = await runLocalQwen(prompt, requestId, {
          model: data.model,
          maxTokens: data.maxTokens,
          temperature: data.temperature,
          imagePath: imagePath
            ? (path.isAbsolute(imagePath) ? imagePath : path.join(DATA_DIR, imagePath))
            : null
        });
      } else {
        result = await runGrok(prompt, sessionId, requestId, {
          model: data.model,
          tools: data.tools,
          maxTurns: data.maxTurns
        });
      }

      const duration = Date.now() - startTime;

      logger.info({
        requestId,
        type: 'http_response',
        durationMs: duration,
        responseLength: result.response.length,
        provider: result.provider,
        usage: result.usage,
        totalCostUsd: result.totalCostUsd,
        ...(LOG_SENSITIVE ? { fullResponse: result.response } : {})
      }, `[${requestId}] Response sent in ${duration}ms`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        response: result.response,
        durationMs: duration,
        requestId,
        sessionId: result.sessionId || null,
        provider: result.provider,
        usage: result.usage,
        modelUsage: result.modelUsage,
        totalCostUsd: result.totalCostUsd,
        stopReason: result.stopReason
      }));
    } catch (error) {
      logger.error({
        requestId,
        type: 'request_error',
        error: error.message,
        stack: error.stack
      }, `[${requestId}] Error: ${error.message}`);

      res.writeHead(500);
      res.end(JSON.stringify({
        success: false,
        error: error.message,
        requestId
      }));
    }
  });
});

server.listen(PORT, () => {
  logger.info({
    type: 'server_started',
    port: PORT,
    version: SERVICE_VERSION,
    grokBin: GROK_BIN,
    sensitiveLogging: LOG_SENSITIVE,
    localAiConfigured: !!LOCAL_AI_BASE_URL,
    logFile
  }, `Grok proxy v${SERVICE_VERSION} listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info({ type: 'shutdown', signal: 'SIGTERM' }, 'Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info({ type: 'shutdown', signal: 'SIGINT' }, 'Shutting down...');
  server.close(() => process.exit(0));
});
