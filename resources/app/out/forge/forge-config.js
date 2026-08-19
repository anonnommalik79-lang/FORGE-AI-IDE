/*---------------------------------------------------------------------------------------------
 *  FORGE - AI Coding Platform
 *  Configuration bootstrap.
 *
 *  Runs as a classic (non-module) script BEFORE the workbench module graph is evaluated, so the
 *  values below are already on `globalThis` by the time the AI provider defaults are constructed.
 *
 *  Reads out/forge/forge.config.json. Never contains secrets in source control - the file ships
 *  with empty values and is filled in per installation.
 *--------------------------------------------------------------------------------------------*/
(function () {
	'use strict';

	var cfg = { baseUrl: '', apiKey: '', model: 'MalikLLM75B', headersJSON: '{}' };

	try {
		// Same-origin synchronous read. Sync XHR is intentional: the provider defaults are built
		// during module evaluation of the workbench bundle, which starts immediately after this
		// script. The file is a few hundred bytes on local disk.
		var xhr = new XMLHttpRequest();
		xhr.open('GET', '../../../../forge/forge.config.json', false);
		xhr.send(null);
		if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
			var raw = JSON.parse(xhr.responseText);
			cfg.baseUrl = String(raw.FORGE_API_BASE_URL || '');
			cfg.apiKey = String(raw.FORGE_API_KEY || '');
			cfg.model = String(raw.FORGE_MODEL || 'MalikLLM75B');
			cfg.headersJSON = String(raw.FORGE_HEADERS_JSON || '{}');
		}
	} catch (e) {
		// Missing or malformed config is not fatal: FORGE falls back to unconfigured defaults and
		// the user configures the engine from FORGE Settings.
		try { console.warn('[FORGE] config not loaded, using defaults:', e && e.message); } catch (e2) { /* noop */ }
	}

	globalThis._FORGE_CONFIG = cfg;
})();
