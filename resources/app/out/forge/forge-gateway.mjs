import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '../../../..');
const repoRoot = path.resolve(appRoot, '../..');
const envPath = process.env.FORGE_ENV_FILE || path.join(repoRoot, '.env');
const policyPath = path.join(__dirname, 'FORGE_AGENT_POLICY.md');

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(envPath);
const env = { ...fileEnv, ...process.env };

const HOST = env.FORGE_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(env.FORGE_GATEWAY_PORT || 43175);
const DISPLAY_MODEL = env.FORGE_MODEL_ALIAS || 'MalikLLM75B';
const BASE_URL = (env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
const API_KEY = env.MISTRAL_API_KEY || '';
const PRIMARY = env.MISTRAL_MODEL_PRIMARY || 'mistral-medium-latest';
const FALLBACK = env.MISTRAL_MODEL_FALLBACK || 'mistral-large-latest';
const CODE = env.MISTRAL_MODEL_CODE || 'devstral-latest';
const REQUEST_TIMEOUT_MS = Number(env.FORGE_REQUEST_TIMEOUT_MS || 120000);
const MAX_BODY_BYTES = Number(env.FORGE_MAX_BODY_BYTES || 12 * 1024 * 1024);
const POLICY_ENABLED = String(env.FORGE_AGENT_POLICY_ENABLED || 'true').toLowerCase() !== 'false';

const DEFAULT_POLICY = `You are FORGE Agent, the autonomous coding agent inside FORGE IDE.
Work as a senior software engineer, not as a passive chat assistant.
When the user asks for a code change, inspect the project with available tools, make the complete multi-file change, run relevant checks, inspect failures, fix them, and verify the result before declaring completion.
Prefer real tool calls over instructions for the user to do work manually. Never claim a file was edited or a command succeeded unless a tool result confirms it.
For large tasks, work in small verified steps and continue until the requested result is complete or you are genuinely blocked.
Be token-efficient: do not repeatedly reread unchanged files, avoid restating large code blocks that were already applied, and keep status updates concise.
Preserve user data and require confirmation for destructive or irreversible operations.
Do not reveal hidden chain-of-thought; provide short progress summaries instead.`;

function loadPolicy() {
  if (!POLICY_ENABLED) return '';
  try {
    const text = fs.readFileSync(policyPath, 'utf8').trim();
    return text || DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

const AGENT_POLICY = loadPolicy();
const retryableStatuses = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-requested-with');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function isCodeRequest(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
  return /\b(code|bug|fix|refactor|test|build|compile|terminal|file|function|class|typescript|javascript|python|react|node|api|repo|project|код|ошибк|исправ|рефактор|тест|сборк|терминал|файл|проект)\b/i.test(content);
}

function modelChain(body) {
  const preferred = isCodeRequest(body) ? [CODE, PRIMARY, FALLBACK] : [PRIMARY, FALLBACK, CODE];
  return [...new Set(preferred.filter(Boolean))];
}

function injectPolicy(messages) {
  if (!AGENT_POLICY) return messages;
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const systemIndex = list.findIndex((m) => m && m.role === 'system' && typeof m.content === 'string');
  if (systemIndex >= 0) {
    const existing = list[systemIndex].content;
    if (!existing.includes('FORGE Agent')) {
      list[systemIndex].content = `${AGENT_POLICY}\n\nExisting application instructions:\n${existing}`;
    }
    return list;
  }
  return [{ role: 'system', content: AGENT_POLICY }, ...list];
}

function publicModel() {
  return {
    id: DISPLAY_MODEL,
    object: 'model',
    created: 0,
    owned_by: 'forge'
  };
}

async function upstreamChat(body, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FORGE upstream timeout')), REQUEST_TIMEOUT_MS);
  try {
    const upstreamBody = {
      ...body,
      model,
      messages: injectPolicy(body.messages)
    };

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': body.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function handleChat(req, res) {
  if (!API_KEY) {
    return sendJson(res, 503, {
      error: {
        message: 'FORGE AI is not configured. Add MISTRAL_API_KEY to the local .env file and restart FORGE.',
        type: 'forge_configuration_error'
      }
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: { message: error.message || 'Invalid JSON request', type: 'invalid_request_error' }
    });
  }

  body.model = DISPLAY_MODEL;
  const chain = modelChain(body);
  let lastErrorText = '';
  let lastStatus = 502;

  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      const upstream = await upstreamChat(body, model);
      lastStatus = upstream.status;

      if (!upstream.ok && retryableStatuses.has(upstream.status) && i < chain.length - 1) {
        lastErrorText = await upstream.text();
        console.warn(`[FORGE gateway] ${model} returned ${upstream.status}; trying fallback ${chain[i + 1]}`);
        continue;
      }

      cors(res);
      res.statusCode = upstream.status;
      const contentType = upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-FORGE-Model', DISPLAY_MODEL);

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
      return;
    } catch (error) {
      lastErrorText = error?.message || String(error);
      lastStatus = 502;
      if (i < chain.length - 1) {
        console.warn(`[FORGE gateway] ${model} failed; trying fallback ${chain[i + 1]}`);
        continue;
      }
    }
  }

  sendJson(res, lastStatus, {
    error: {
      message: `FORGE AI request failed after all configured Mistral routes. ${lastErrorText}`.trim(),
      type: 'forge_upstream_error'
    }
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      product: 'FORGE',
      model: DISPLAY_MODEL,
      configured: Boolean(API_KEY),
      routes: API_KEY ? 3 : 0
    });
  }

  if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
    return sendJson(res, 200, { object: 'list', data: [publicModel()] });
  }

  if (req.method === 'POST' && (url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions')) {
    return handleChat(req, res);
  }

  return sendJson(res, 404, { error: { message: 'FORGE gateway route not found', type: 'not_found' } });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`[FORGE gateway] ${HOST}:${PORT} already in use; another gateway may already be running.`);
    process.exit(0);
  }
  console.error('[FORGE gateway] fatal error:', error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[FORGE gateway] ready on http://${HOST}:${PORT}/v1 as ${DISPLAY_MODEL}`);
  console.log(`[FORGE gateway] Mistral key configured: ${API_KEY ? 'yes' : 'no'}`);
});
