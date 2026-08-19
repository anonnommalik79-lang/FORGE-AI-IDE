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

function boolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function providerFromEnv(env, id, defaults = {}) {
  const prefix = id.toUpperCase();
  return {
    id,
    baseUrl: normalizeBaseUrl(env[`${prefix}_BASE_URL`] || defaults.baseUrl || ''),
    apiKey: String(env[`${prefix}_API_KEY`] || '').trim(),
    primary: String(env[`${prefix}_MODEL_PRIMARY`] || defaults.primary || '').trim(),
    fallback: String(env[`${prefix}_MODEL_FALLBACK`] || defaults.fallback || '').trim(),
    code: String(env[`${prefix}_MODEL_CODE`] || defaults.code || '').trim(),
    keyOptional: Boolean(defaults.keyOptional)
  };
}

function getConfig() {
  // .env wins over the process snapshot so edits take effect without restarting the gateway.
  const env = { ...process.env, ...parseEnvFile(envPath) };
  const providerOrder = String(env.FORGE_PROVIDER_ORDER || 'omniroute,mistral,cerebras,groq,gemini')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const providers = {
    omniroute: providerFromEnv(env, 'omniroute', {
      baseUrl: 'http://127.0.0.1:20128/v1',
      primary: 'auto/coding:free',
      code: 'auto/coding:free',
      keyOptional: true
    }),
    mistral: providerFromEnv(env, 'mistral', {
      baseUrl: 'https://api.mistral.ai/v1',
      primary: 'mistral-medium-latest',
      fallback: 'mistral-large-latest',
      code: 'devstral-latest'
    }),
    cerebras: providerFromEnv(env, 'cerebras', {
      baseUrl: 'https://api.cerebras.ai/v1',
      primary: 'gpt-oss-120b',
      code: 'gpt-oss-120b'
    }),
    groq: providerFromEnv(env, 'groq', {
      baseUrl: 'https://api.groq.com/openai/v1',
      primary: 'openai/gpt-oss-120b',
      code: 'openai/gpt-oss-120b'
    }),
    gemini: providerFromEnv(env, 'gemini', {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      primary: 'gemini-3.5-flash',
      code: 'gemini-3.5-flash'
    })
  };

  return {
    host: env.FORGE_GATEWAY_HOST || '127.0.0.1',
    port: positiveInt(env.FORGE_GATEWAY_PORT, 43175),
    displayModel: env.FORGE_MODEL_ALIAS || 'MalikLLM75B',
    providerOrder,
    providers,
    failoverEnabled: boolEnv(env.FORGE_FAILOVER_ENABLED, true),
    maxRetries: positiveInt(env.FORGE_MAX_RETRIES, 2),
    cooldownMs: positiveInt(env.FORGE_PROVIDER_COOLDOWN_MS, 60000),
    timeoutMs: positiveInt(env.FORGE_REQUEST_TIMEOUT_MS, 120000),
    maxBodyBytes: positiveInt(env.FORGE_MAX_BODY_BYTES, 12 * 1024 * 1024),
    policyEnabled: boolEnv(env.FORGE_AGENT_POLICY_ENABLED, true)
  };
}

const initialConfig = getConfig();
const HOST = initialConfig.host;
const PORT = initialConfig.port;
const providerHealth = new Map();

const DEFAULT_POLICY = `You are FORGE Agent, the autonomous coding agent inside FORGE IDE.
Work as a senior software engineer, not as a passive chat assistant.
When the user asks for a code change, inspect the project with available tools, make the complete multi-file change, run relevant checks, inspect failures, fix them, and verify the result before declaring completion.
Prefer real tool calls over instructions for the user to do work manually. Never claim a file was edited or a command succeeded unless a tool result confirms it.
For large tasks, work in small verified steps and continue until the requested result is complete or you are genuinely blocked.
Be token-efficient: do not repeatedly reread unchanged files, avoid restating large code blocks that were already applied, and keep status updates concise.
Preserve user data and require confirmation for destructive or irreversible operations.
Do not reveal hidden chain-of-thought; provide short progress summaries instead.`;

function loadPolicy(cfg) {
  if (!cfg.policyEnabled) return '';
  try {
    const text = fs.readFileSync(policyPath, 'utf8').trim();
    return text || DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

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

async function readJson(req, maxBodyBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
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

function injectPolicy(messages, cfg) {
  const policy = loadPolicy(cfg);
  if (!policy) return messages;
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const systemIndex = list.findIndex((m) => m && m.role === 'system' && typeof m.content === 'string');
  if (systemIndex >= 0) {
    const existing = list[systemIndex].content;
    if (!existing.includes('FORGE Agent')) {
      list[systemIndex].content = `${policy}\n\nExisting application instructions:\n${existing}`;
    }
    return list;
  }
  return [{ role: 'system', content: policy }, ...list];
}

function publicModel(cfg) {
  return {
    id: cfg.displayModel,
    object: 'model',
    created: 0,
    owned_by: 'forge'
  };
}

function providerConfigured(provider) {
  if (!provider || !provider.baseUrl) return false;
  if (!provider.primary && !provider.fallback && !provider.code) return false;
  return provider.keyOptional || Boolean(provider.apiKey);
}

function providerState(id) {
  if (!providerHealth.has(id)) {
    providerHealth.set(id, { failures: 0, cooldownUntil: 0, lastStatus: 0 });
  }
  return providerHealth.get(id);
}

function inCooldown(id) {
  return providerState(id).cooldownUntil > Date.now();
}

function markProviderSuccess(id) {
  const state = providerState(id);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastStatus = 200;
}

function markProviderFailure(id, status, cfg) {
  const state = providerState(id);
  state.failures += 1;
  state.lastStatus = status || 0;
  if (status === 429 || status >= 500 || status === 0) {
    state.cooldownUntil = Date.now() + cfg.cooldownMs;
  }
}

function modelsForProvider(provider, codeRequest) {
  const preferred = codeRequest
    ? [provider.code, provider.primary, provider.fallback]
    : [provider.primary, provider.fallback, provider.code];
  return [...new Set(preferred.filter(Boolean))];
}

function buildRoutes(body, cfg) {
  const codeRequest = isCodeRequest(body);
  const routes = [];
  const seen = new Set();

  for (const id of cfg.providerOrder) {
    const provider = cfg.providers[id];
    if (!providerConfigured(provider)) continue;
    if (inCooldown(id)) continue;

    for (const model of modelsForProvider(provider, codeRequest)) {
      const key = `${id}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ provider, model });
    }
  }

  if (!cfg.failoverEnabled && routes.length > 1) {
    return [routes[0]];
  }
  return routes;
}

function authHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

async function upstreamChat(body, route, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FORGE upstream timeout')), cfg.timeoutMs);
  try {
    const upstreamBody = {
      ...body,
      model: route.model,
      messages: injectPolicy(body.messages, cfg)
    };

    const response = await fetch(`${route.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders(route.provider),
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

async function safeErrorText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 2000);
  } catch {
    return '';
  }
}

async function handleChat(req, res) {
  const cfg = getConfig();

  let body;
  try {
    body = await readJson(req, cfg.maxBodyBytes);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: { message: error.message || 'Invalid JSON request', type: 'invalid_request_error' }
    });
  }

  body.model = cfg.displayModel;
  const routes = buildRoutes(body, cfg);
  if (routes.length === 0) {
    return sendJson(res, 503, {
      error: {
        message: 'FORGE AI has no available provider routes. Configure at least one provider in the local .env file or wait for a provider cooldown to expire.',
        type: 'forge_configuration_error'
      }
    });
  }

  let lastStatus = 502;
  let attemptCount = 0;

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    const maxAttempts = Math.max(1, cfg.maxRetries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attemptCount += 1;
      try {
        const upstream = await upstreamChat(body, route, cfg);
        lastStatus = upstream.status;

        if (!upstream.ok) {
          const errorText = await safeErrorText(upstream);
          markProviderFailure(route.provider.id, upstream.status, cfg);
          console.warn(`[FORGE gateway] ${route.provider.id}/${route.model} failed with ${upstream.status}${errorText ? `: ${errorText}` : ''}`);

          const retrySameRoute = retryableStatuses.has(upstream.status)
            && upstream.status !== 429
            && attempt < maxAttempts - 1;
          if (retrySameRoute) continue;

          const hasNextRoute = routeIndex < routes.length - 1;
          if (cfg.failoverEnabled && hasNextRoute) break;

          return sendJson(res, upstream.status, {
            error: {
              message: 'FORGE AI upstream route failed.',
              type: 'forge_upstream_error'
            }
          });
        }

        markProviderSuccess(route.provider.id);
        cors(res);
        res.statusCode = upstream.status;
        const contentType = upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-FORGE-Model', cfg.displayModel);

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
        lastStatus = 502;
        markProviderFailure(route.provider.id, 0, cfg);
        console.warn(`[FORGE gateway] ${route.provider.id}/${route.model} network failure: ${error?.message || String(error)}`);

        if (attempt < maxAttempts - 1) continue;
        if (cfg.failoverEnabled && routeIndex < routes.length - 1) break;
      }
    }
  }

  sendJson(res, lastStatus, {
    error: {
      message: `FORGE AI request failed after ${attemptCount} route attempt${attemptCount === 1 ? '' : 's'}.`,
      type: 'forge_upstream_error'
    }
  });
}

function routeStats(cfg) {
  let configuredProviders = 0;
  let availableProviders = 0;
  let configuredRoutes = 0;

  for (const id of cfg.providerOrder) {
    const provider = cfg.providers[id];
    if (!providerConfigured(provider)) continue;
    configuredProviders += 1;
    configuredRoutes += modelsForProvider(provider, false).length;
    if (!inCooldown(id)) availableProviders += 1;
  }

  return { configuredProviders, availableProviders, configuredRoutes };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const cfg = getConfig();

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    const stats = routeStats(cfg);
    return sendJson(res, 200, {
      ok: stats.availableProviders > 0,
      product: 'FORGE',
      model: cfg.displayModel,
      configuredProviders: stats.configuredProviders,
      availableProviders: stats.availableProviders,
      routes: stats.configuredRoutes,
      failover: cfg.failoverEnabled
    });
  }

  if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
    return sendJson(res, 200, { object: 'list', data: [publicModel(cfg)] });
  }

  if (req.method === 'POST' && (url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions')) {
    return handleChat(req, res);
  }

  return sendJson(res, 404, { error: { message: 'FORGE gateway route not found', type: 'not_found' } });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`[FORGE gateway] ${HOST}:${PORT} already in use; another FORGE gateway may already be running.`);
    process.exit(0);
  }
  console.error('[FORGE gateway] fatal error:', error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const cfg = getConfig();
  const stats = routeStats(cfg);
  console.log(`[FORGE gateway] ready on http://${HOST}:${PORT}/v1 as ${cfg.displayModel}`);
  console.log(`[FORGE gateway] providers configured: ${stats.configuredProviders}; available: ${stats.availableProviders}; routes: ${stats.configuredRoutes}`);
});
