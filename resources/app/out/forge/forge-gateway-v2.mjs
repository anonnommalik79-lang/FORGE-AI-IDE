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
const VERSION = '2.0.0';

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

function boolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function intEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function provider(env, id, defaults = {}) {
  const p = id.toUpperCase();
  return {
    id,
    baseUrl: cleanUrl(env[`${p}_BASE_URL`] || defaults.baseUrl || ''),
    apiKey: String(env[`${p}_API_KEY`] || '').trim(),
    primary: String(env[`${p}_MODEL_PRIMARY`] || defaults.primary || '').trim(),
    fallback: String(env[`${p}_MODEL_FALLBACK`] || defaults.fallback || '').trim(),
    code: String(env[`${p}_MODEL_CODE`] || defaults.code || '').trim(),
    keyOptional: Boolean(defaults.keyOptional),
    preserveMessages: Boolean(defaults.preserveMessages)
  };
}

function getConfig() {
  const env = { ...process.env, ...parseEnvFile(envPath) };
  const providers = {
    omniroute: provider(env, 'omniroute', {
      baseUrl: 'http://127.0.0.1:20128/v1',
      primary: 'auto/coding:free',
      code: 'auto/coding:free',
      keyOptional: true,
      preserveMessages: true
    }),
    mistral: provider(env, 'mistral', {
      baseUrl: 'https://api.mistral.ai/v1',
      primary: 'mistral-medium-latest',
      fallback: 'mistral-large-latest',
      code: 'devstral-latest'
    }),
    cerebras: provider(env, 'cerebras', {
      baseUrl: 'https://api.cerebras.ai/v1',
      primary: 'gpt-oss-120b',
      code: 'gpt-oss-120b'
    }),
    groq: provider(env, 'groq', {
      baseUrl: 'https://api.groq.com/openai/v1',
      primary: 'openai/gpt-oss-120b',
      code: 'openai/gpt-oss-120b'
    }),
    gemini: provider(env, 'gemini', {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      primary: 'gemini-3.5-flash',
      code: 'gemini-3.5-flash'
    })
  };

  return {
    host: env.FORGE_GATEWAY_HOST || '127.0.0.1',
    port: intEnv(env.FORGE_GATEWAY_PORT, 43175),
    alias: env.FORGE_MODEL_ALIAS || 'MalikLLM75B',
    order: String(env.FORGE_PROVIDER_ORDER || 'omniroute,mistral,cerebras,groq,gemini')
      .split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
    providers,
    failover: boolEnv(env.FORGE_FAILOVER_ENABLED, true),
    retries: intEnv(env.FORGE_MAX_RETRIES, 1),
    cooldownMs: intEnv(env.FORGE_PROVIDER_COOLDOWN_MS, 60000),
    timeoutMs: intEnv(env.FORGE_REQUEST_TIMEOUT_MS, 120000),
    maxBodyBytes: intEnv(env.FORGE_MAX_BODY_BYTES, 12 * 1024 * 1024),
    policyEnabled: boolEnv(env.FORGE_AGENT_POLICY_ENABLED, true)
  };
}

const initial = getConfig();
const HOST = initial.host;
const PORT = initial.port;
const state = new Map();
let lastRequest = null;

const DEFAULT_POLICY = `You are FORGE Agent inside FORGE IDE. Work as an autonomous senior software engineer. Use available tools to inspect files, make complete changes, run relevant checks, fix failures, and verify results before claiming completion. Never invent tool results. Keep progress concise and do not reveal hidden chain-of-thought.`;

function loadPolicy(cfg) {
  if (!cfg.policyEnabled) return '';
  try {
    const text = fs.readFileSync(policyPath, 'utf8').trim();
    return text || DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

function injectPolicy(messages, cfg) {
  const policy = loadPolicy(cfg);
  if (!policy) return messages;
  const list = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
  const idx = list.findIndex(m => m && m.role === 'system' && typeof m.content === 'string');
  if (idx >= 0) {
    if (!list[idx].content.includes('FORGE Agent')) {
      list[idx].content = `${policy}\n\nExisting application instructions:\n${list[idx].content}`;
    }
    return list;
  }
  return [{ role: 'system', content: policy }, ...list];
}

function pstate(id) {
  if (!state.has(id)) state.set(id, { failures: 0, cooldownUntil: 0, lastStatus: 0, lastError: '', lastSuccess: 0 });
  return state.get(id);
}

function configured(p) {
  if (!p || !p.baseUrl) return false;
  if (!p.primary && !p.fallback && !p.code) return false;
  return p.keyOptional || Boolean(p.apiKey);
}

function inCooldown(id) {
  return pstate(id).cooldownUntil > Date.now();
}

function markSuccess(id) {
  const s = pstate(id);
  s.failures = 0;
  s.cooldownUntil = 0;
  s.lastStatus = 200;
  s.lastError = '';
  s.lastSuccess = Date.now();
}

function markFailure(id, status, message, cfg) {
  const s = pstate(id);
  s.failures += 1;
  s.lastStatus = status || 0;
  s.lastError = String(message || '').slice(0, 500);
  if (status === 0 || status === 401 || status === 403 || status === 429 || status >= 500) {
    s.cooldownUntil = Date.now() + cfg.cooldownMs;
  }
}

function modelsFor(p, codeRequest) {
  const list = codeRequest ? [p.code, p.primary, p.fallback] : [p.primary, p.fallback, p.code];
  return [...new Set(list.filter(Boolean))];
}

function isCodeRequest(body) {
  if (Array.isArray(body.tools) && body.tools.length) return true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = [...messages].reverse().find(m => m && m.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : '';
  return /\b(code|bug|fix|refactor|test|build|compile|terminal|file|typescript|javascript|python|react|node|api|repo|project|код|ошибк|исправ|рефактор|тест|сборк|терминал|файл|проект)\b/i.test(text);
}

function routesFor(body, cfg) {
  const codeRequest = isCodeRequest(body);
  const routes = [];
  const seen = new Set();
  for (const id of cfg.order) {
    const p = cfg.providers[id];
    if (!configured(p) || inCooldown(id)) continue;
    for (const model of modelsFor(p, codeRequest)) {
      const key = `${id}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ provider: p, model });
    }
  }
  return cfg.failover ? routes : routes.slice(0, 1);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-requested-with');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const e = new Error('Request body too large');
      e.statusCode = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function authHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}

async function callRoute(originalBody, route, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FORGE upstream timeout')), cfg.timeoutMs);
  try {
    const outbound = {
      ...originalBody,
      model: route.model,
      messages: route.provider.preserveMessages
        ? originalBody.messages
        : injectPolicy(originalBody.messages, cfg)
    };

    return await fetch(`${route.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders(route.provider),
        Accept: originalBody.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(outbound),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function responseText(response) {
  try { return (await response.text()).slice(0, 2000); }
  catch { return ''; }
}

function publicModel(cfg) {
  return { id: cfg.alias, object: 'model', created: 0, owned_by: 'forge' };
}

async function relaySuccess(upstream, res, body, cfg) {
  cors(res);
  res.statusCode = upstream.status;
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-FORGE-Model', cfg.alias);

  const contentType = upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json');
  res.setHeader('Content-Type', contentType);

  if (!upstream.body) return res.end();

  if (!body.stream && contentType.includes('application/json')) {
    try {
      const parsed = await upstream.json();
      if (parsed && typeof parsed === 'object') parsed.model = cfg.alias;
      return res.end(JSON.stringify(parsed));
    } catch {
      return res.end();
    }
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
}

async function handleChat(req, res) {
  const cfg = getConfig();
  let body;
  try {
    body = await readJson(req, cfg.maxBodyBytes);
  } catch (error) {
    return json(res, error.statusCode || 400, { error: { message: error.message || 'Invalid request', type: 'invalid_request_error' } });
  }

  body.model = cfg.alias;
  const routes = routesFor(body, cfg);
  if (!routes.length) {
    return json(res, 503, { error: { message: 'MalikLLM75B has no available provider route.', type: 'forge_configuration_error' } });
  }

  const blocked = new Set();
  const attempts = [];
  let lastStatus = 502;

  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    if (blocked.has(route.provider.id)) continue;

    const maxAttempts = Math.max(1, cfg.retries + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const upstream = await callRoute(body, route, cfg);
        lastStatus = upstream.status;

        if (upstream.ok) {
          markSuccess(route.provider.id);
          attempts.push({ provider: route.provider.id, model: route.model, status: upstream.status, ok: true });
          lastRequest = { at: Date.now(), ok: true, attempts };
          return relaySuccess(upstream, res, body, cfg);
        }

        const text = await responseText(upstream);
        attempts.push({ provider: route.provider.id, model: route.model, status: upstream.status, ok: false, error: text.slice(0, 500) });
        markFailure(route.provider.id, upstream.status, text, cfg);

        if (upstream.status === 401 || upstream.status === 403) {
          blocked.add(route.provider.id);
          break;
        }

        const retryable = [408, 409, 425, 500, 502, 503, 504].includes(upstream.status);
        if (retryable && attempt < maxAttempts - 1) continue;
        break;
      } catch (error) {
        const message = error?.message || String(error);
        attempts.push({ provider: route.provider.id, model: route.model, status: 0, ok: false, error: message.slice(0, 500) });
        markFailure(route.provider.id, 0, message, cfg);
        if (attempt < maxAttempts - 1) continue;
        blocked.add(route.provider.id);
        break;
      }
    }
  }

  lastRequest = { at: Date.now(), ok: false, attempts };
  return json(res, lastStatus, {
    error: {
      message: 'MalikLLM75B could not reach a working provider route. Open /v1/diagnostics for the exact local route status.',
      type: 'forge_upstream_error'
    }
  });
}

function diagnostics(cfg) {
  return {
    version: VERSION,
    product: 'FORGE',
    model: cfg.alias,
    providerOrder: cfg.order,
    providers: cfg.order.map(id => {
      const p = cfg.providers[id];
      const s = pstate(id);
      return {
        id,
        configured: configured(p),
        available: configured(p) && !inCooldown(id),
        routes: p ? modelsFor(p, false).length : 0,
        lastStatus: s.lastStatus,
        failures: s.failures,
        cooldownRemainingMs: Math.max(0, s.cooldownUntil - Date.now()),
        lastError: s.lastError
      };
    }),
    lastRequest
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const cfg = getConfig();
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    const configuredCount = cfg.order.filter(id => configured(cfg.providers[id])).length;
    const availableCount = cfg.order.filter(id => configured(cfg.providers[id]) && !inCooldown(id)).length;
    return json(res, 200, {
      ok: true,
      gatewayReady: true,
      routingReady: availableCount > 0,
      version: VERSION,
      product: 'FORGE',
      model: cfg.alias,
      configuredProviders: configuredCount,
      availableProviders: availableCount,
      failover: cfg.failover
    });
  }

  if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
    return json(res, 200, { object: 'list', data: [publicModel(cfg)] });
  }

  if (req.method === 'GET' && (url.pathname === '/diagnostics' || url.pathname === '/v1/diagnostics')) {
    return json(res, 200, diagnostics(cfg));
  }

  if (req.method === 'POST' && (url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions')) {
    return handleChat(req, res);
  }

  return json(res, 404, { error: { message: 'FORGE gateway route not found', type: 'not_found' } });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.log(`[FORGE gateway v${VERSION}] ${HOST}:${PORT} already in use.`);
    process.exit(0);
  }
  console.error(`[FORGE gateway v${VERSION}] fatal: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const cfg = getConfig();
  console.log(`[FORGE gateway v${VERSION}] ready on http://${HOST}:${PORT}/v1 as ${cfg.alias}`);
});
