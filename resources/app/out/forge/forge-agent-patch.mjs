import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundlePath = path.resolve(__dirname, '../vs/workbench/workbench.desktop.main.js');

const ORIGINAL = 'e.settingsOfProvider[n]={...zqe[n],...e.settingsOfProvider[n]};for(const s of e.settingsOfProvider[n].models)if(!s.type){';
const PATCHED = 'e.settingsOfProvider[n]={...zqe[n],...e.settingsOfProvider[n]};if(n==="openAICompatible"){const f=globalThis._FORGE_CONFIG||{};e.settingsOfProvider[n]={...e.settingsOfProvider[n],endpoint:f.baseUrl||"http://127.0.0.1:43175/v1",apiKey:f.apiKey||"forge-local-gateway",headersJSON:f.headersJSON||"{}",models:[{modelName:f.model||"MalikLLM75B",type:"default",isHidden:!1}]}}for(const s of e.settingsOfProvider[n].models)if(!s.type){';
const MARKER = 'endpoint:f.baseUrl||"http://127.0.0.1:43175/v1",apiKey:f.apiKey||"forge-local-gateway"';

function fail(message) {
  console.error(`[FORGE Agent patch] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(bundlePath)) {
  fail(`workbench bundle not found: ${bundlePath}`);
}

let source = fs.readFileSync(bundlePath, 'utf8');

if (source.includes(MARKER)) {
  console.log('[FORGE Agent patch] local gateway settings already locked.');
  process.exit(0);
}

const matches = source.split(ORIGINAL).length - 1;
if (matches !== 1) {
  fail(`expected exactly one settings merge site, found ${matches}. Refusing an unsafe patch.`);
}

source = source.replace(ORIGINAL, PATCHED);

if (!source.includes(MARKER)) {
  fail('verification failed after patching.');
}

fs.writeFileSync(bundlePath, source, 'utf8');
console.log('[FORGE Agent patch] persisted provider state can no longer override MalikLLM75B local gateway settings.');
