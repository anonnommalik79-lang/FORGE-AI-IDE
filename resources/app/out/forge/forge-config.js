/*---------------------------------------------------------------------------------------------
 * FORGE - AI configuration bootstrap
 * Loads the public FORGE model identity before the workbench module graph starts.
 * Secrets never live here; the local gateway reads MISTRAL_API_KEY from the gitignored .env file.
 *--------------------------------------------------------------------------------------------*/
(function () {
  'use strict';

  var cfg = {
    baseUrl: 'http://127.0.0.1:43175/v1',
    apiKey: '',
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
      cfg.apiKey = String(raw.FORGE_API_KEY || '');
      cfg.model = String(raw.FORGE_MODEL || 'MalikLLM75B');
      cfg.headersJSON = String(raw.FORGE_HEADERS_JSON || '{}');
    }
  } catch (e) {
    try { console.warn('[FORGE] config not loaded, using local gateway defaults:', e && e.message); } catch (e2) { /* noop */ }
  }

  globalThis._FORGE_CONFIG = cfg;
})();
