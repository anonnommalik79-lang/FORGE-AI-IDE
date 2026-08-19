/*---------------------------------------------------------------------------------------------
 * FORGE - AI configuration bootstrap
 * Loads the public FORGE model identity before the workbench module graph starts.
 * Real provider secrets never live here; the local gateway reads MISTRAL_API_KEY from .env.
 * The non-secret local token only satisfies the compiled provider's client-side key requirement.
 *--------------------------------------------------------------------------------------------*/
(function () {
  'use strict';

  var LOCAL_GATEWAY_TOKEN = 'forge-local-gateway';
  var cfg = {
    baseUrl: 'http://127.0.0.1:43175/v1',
    apiKey: LOCAL_GATEWAY_TOKEN,
    model: 'MalikLLM75B',
    headersJSON: '{}'
  };

  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '../../../../forge/forge.config.json', false);
    xhr.send(null);
    if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
      var raw = JSON.parse(xhr.responseText);
      cfg.baseUrl = String(raw.FORGE_API_BASE_URL || cfg.baseUrl);
      cfg.apiKey = String(raw.FORGE_API_KEY || LOCAL_GATEWAY_TOKEN);
      cfg.model = String(raw.FORGE_MODEL || 'MalikLLM75B');
      cfg.headersJSON = String(raw.FORGE_HEADERS_JSON || '{}');
    }
  } catch (e) {
    try { console.warn('[FORGE] config not loaded, using local gateway defaults:', e && e.message); } catch (e2) { /* noop */ }
  }

  // Public compatibility object consumed by the compiled Agent provider.
  // The real Mistral credential is never exposed to the renderer.
  globalThis._FORGE_CONFIG = cfg;
})();
