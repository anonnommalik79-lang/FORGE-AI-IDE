/*---------------------------------------------------------------------------------------------
 * FORGE - provider compatibility surface
 * The compiled Agent still uses the internal provider id "openAICompatible" for protocol
 * compatibility. Users must never see that implementation detail: the product engine is
 * MalikLLM75B and all real upstream credentials stay behind the local FORGE gateway.
 *--------------------------------------------------------------------------------------------*/

const FORGE_PROVIDER_REPLACEMENTS = [
  [/Model\s+openAICompatible:MalikLLM75B/gi, 'Model MalikLLM75B'],
  [/openAICompatible:MalikLLM75B/gi, 'MalikLLM75B'],
  [/Invalid\s+OpenAI[- ]Compatible\s+API\s+key\.?/gi, 'MalikLLM75B gateway authentication failed.'],
  [/OpenAI[- ]Compatible\s+API\s+key/gi, 'MalikLLM75B gateway key'],
  [/OpenAI[- ]Compatible/gi, 'MalikLLM75B'],
  [/openAICompatible/gi, 'MalikLLM75B']
];

const SAFE_ROOTS = [
  '.auxiliarybar',
  '.sidebar',
  '.pane-composite-part',
  '.statusbar',
  '.notifications-toasts',
  '.monaco-dialog-box',
  '.context-view',
  '.quick-input-widget'
];

const SKIP = '.monaco-editor,.terminal,.xterm,.webview,.notebook-editor,.output-view,.debug-console,.repl';
let queued = false;

function replaceForgeProviderText(value) {
  if (!value || typeof value !== 'string') return value;
  let next = value;
  for (const [pattern, replacement] of FORGE_PROVIDER_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

function safe(node) {
  try { return !node?.matches?.(SKIP) && !node?.closest?.(SKIP); }
  catch { return true; }
}

function scrub(root) {
  if (!root || !safe(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    if (!safe(textNode.parentElement)) continue;
    const before = textNode.nodeValue;
    const after = replaceForgeProviderText(before);
    if (before !== after) textNode.nodeValue = after;
  }
  for (const node of root.querySelectorAll('[aria-label],[title],[placeholder]')) {
    if (!safe(node)) continue;
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      if (!node.hasAttribute(attr)) continue;
      const before = node.getAttribute(attr);
      const after = replaceForgeProviderText(before);
      if (before !== after) node.setAttribute(attr, after);
    }
  }
}

function applyForgeProviderSurface() {
  for (const selector of SAFE_ROOTS) {
    for (const root of document.querySelectorAll(selector)) scrub(root);
  }
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    applyForgeProviderSurface();
  });
}

applyForgeProviderSurface();
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
console.log('[FORGE] MalikLLM75B provider surface active');
