import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const envPath = process.env.FORGE_ENV_FILE || path.join(repoRoot, '.env');
const logDir = path.join(repoRoot, 'logs');
const stdoutLog = path.join(logDir, 'omniroute.log');
const stderrLog = path.join(logDir, 'omniroute-error.log');

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

function boolEnv(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function intEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function tcpReady(host, port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpReady(host, port)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function npmRootGlobal() {
  const command = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (command.status !== 0) return '';
  return String(command.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
}

function spawnLogged(command, args, cwd) {
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(stdoutLog, 'a');
  const err = fs.openSync(stderrLog, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err],
      env: process.env
    });
    child.unref();
    return child.pid || 0;
  } catch (error) {
    fs.appendFileSync(stderrLog, `[bootstrap] ${error?.stack || error}\n`);
    return 0;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

function spawnGlobalOmniRoute(port) {
  const npmRoot = npmRootGlobal();
  if (!npmRoot) return { started: false, reason: 'npm global root could not be resolved' };
  const packageRoot = path.join(npmRoot, 'omniroute');
  const entry = path.join(packageRoot, 'bin', 'omniroute.mjs');
  if (!fs.existsSync(entry)) return { started: false, reason: `global OmniRoute entry not found at ${entry}` };

  const pid = spawnLogged(process.execPath, [entry, 'serve', '--no-open', '--port', String(port)], packageRoot);
  return pid
    ? { started: true, reason: `started global OmniRoute (pid ${pid})` }
    : { started: false, reason: 'global OmniRoute process could not be started' };
}

function spawnNpxLatest(port) {
  if (process.platform === 'win32') {
    const cmd = process.env.ComSpec || 'cmd.exe';
    const line = `npx -y omniroute@latest serve --no-open --port ${port}`;
    const pid = spawnLogged(cmd, ['/d', '/s', '/c', line], repoRoot);
    return pid
      ? { started: true, reason: `started npx OmniRoute latest fallback (pid ${pid})` }
      : { started: false, reason: 'npx fallback could not be started' };
  }

  const pid = spawnLogged('npx', ['-y', 'omniroute@latest', 'serve', '--no-open', '--port', String(port)], repoRoot);
  return pid
    ? { started: true, reason: `started npx OmniRoute latest fallback (pid ${pid})` }
    : { started: false, reason: 'npx fallback could not be started' };
}

const fileEnv = parseEnvFile(envPath);
const env = { ...process.env, ...fileEnv };
const providerOrder = String(env.FORGE_PROVIDER_ORDER || 'omniroute,mistral,cerebras,groq,gemini')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

if (!providerOrder.includes('omniroute') || !boolEnv(env.FORGE_AUTOSTART_OMNIROUTE, true)) {
  console.log('[FORGE OmniRoute] autostart not required.');
  process.exit(0);
}

let target;
try {
  target = new URL(env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1');
} catch {
  console.error('[FORGE OmniRoute] invalid OMNIROUTE_BASE_URL.');
  process.exit(2);
}

if (!isLocalHost(target.hostname)) {
  console.log(`[FORGE OmniRoute] remote endpoint configured (${target.origin}); local autostart skipped.`);
  process.exit(0);
}

const host = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname;
const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
const waitMs = intEnv(env.FORGE_OMNIROUTE_START_TIMEOUT_MS, 90000);

if (await tcpReady(host, port)) {
  console.log(`[FORGE OmniRoute] ready on ${host}:${port}.`);
  process.exit(0);
}

console.log(`[FORGE OmniRoute] ${host}:${port} is offline; starting installed OmniRoute...`);
const first = spawnGlobalOmniRoute(port);
console.log(`[FORGE OmniRoute] ${first.reason}.`);

if (first.started && await waitForPort(host, port, waitMs)) {
  console.log(`[FORGE OmniRoute] ready on ${host}:${port}.`);
  process.exit(0);
}

console.log('[FORGE OmniRoute] installed runtime did not become ready; trying latest package fallback...');
const fallback = spawnNpxLatest(port);
console.log(`[FORGE OmniRoute] ${fallback.reason}.`);

if (fallback.started && await waitForPort(host, port, waitMs)) {
  console.log(`[FORGE OmniRoute] ready on ${host}:${port}.`);
  process.exit(0);
}

console.error(`[FORGE OmniRoute] failed to start on ${host}:${port}. See logs/omniroute-error.log.`);
process.exit(2);
