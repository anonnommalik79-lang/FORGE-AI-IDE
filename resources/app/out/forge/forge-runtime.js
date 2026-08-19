/*---------------------------------------------------------------------------------------------
 *  FORGE - AI Coding Platform
 *  Product runtime: RU/EN localization for FORGE-owned UI, the language switcher, and the
 *  welcome-screen onboarding.
 *
 *  Design constraints:
 *   - Never touches editor, explorer, terminal, SCM or extension DOM.
 *   - No innerHTML: the workbench runs under `require-trusted-types-for 'script'`.
 *   - Every mount is idempotent and guarded, so a failure degrades to stock behaviour.
 *--------------------------------------------------------------------------------------------*/

const STORAGE_KEY = 'forge.language';
const SUPPORTED = ['en', 'ru'];
const BASE = new URL('.', import.meta.url);

/** Placeholder strings written into the workbench bundle, mapped to their locale keys. */
const PLACEHOLDER_KEYS = {
	'Ask FORGE to build, fix, explain, or ship...': 'agent.placeholder',
	'Ask FORGE...  @ for context, / for commands': 'agent.placeholder.edit'
};

/** Welcome-page section headings owned by the FORGE onboarding surface. */
const WELCOME_HEADINGS = {
	'Start': 'welcome.section.start',
	'Recent': 'welcome.section.recent',
	'Walkthroughs': 'welcome.section.walkthroughs'
};

const bundles = Object.create(null);
let current = 'en';
let mountTimer = null;

/* ------------------------------------------------------------------------------ helpers ---- */

function readStoredLanguage() {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v && SUPPORTED.indexOf(v) !== -1) {
			return v;
		}
	} catch (e) { /* storage unavailable */ }
	return 'en';
}

function storeLanguage(lang) {
	try {
		localStorage.setItem(STORAGE_KEY, lang);
	} catch (e) { /* storage unavailable */ }
}

function t(key, fallback) {
	const b = bundles[current];
	if (b && typeof b[key] === 'string') {
		return b[key];
	}
	const en = bundles.en;
	if (en && typeof en[key] === 'string') {
		return en[key];
	}
	return fallback !== undefined ? fallback : key;
}

async function loadBundle(lang) {
	if (bundles[lang]) {
		return;
	}
	const res = await fetch(new URL('i18n/' + lang + '.json', BASE).href);
	bundles[lang] = await res.json();
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined && text !== null) {
		node.textContent = text;
	}
	return node;
}

/* -------------------------------------------------------------------- language switcher ---- */

function mountLanguageSwitcher() {
	if (document.querySelector('.forge-lang-switch')) {
		return;
	}
	const host = document.querySelector('.part.titlebar .titlebar-right')
		|| document.querySelector('.part.titlebar .titlebar-container')
		|| document.querySelector('.part.titlebar');
	if (!host) {
		return;
	}

	const wrap = el('div', 'forge-lang-switch');
	wrap.setAttribute('role', 'group');
	wrap.title = t('lang.label', 'Language');
	wrap.setAttribute('aria-label', t('lang.label', 'Language'));

	const globe = el('span', 'forge-lang-switch__globe', '\u{1F310}');
	globe.setAttribute('aria-hidden', 'true');
	wrap.appendChild(globe);

	for (const lang of SUPPORTED) {
		const btn = el('button', 'forge-lang-switch__btn', lang.toUpperCase());
		btn.type = 'button';
		btn.dataset.forgeLang = lang;
		btn.setAttribute('aria-label', lang === 'en' ? 'English' : 'Русский');
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			setLanguage(lang);
		});
		wrap.appendChild(btn);
	}

	// Sit to the left of the window controls rather than on top of them.
	const controls = host.querySelector('.window-controls-container');
	if (controls) {
		host.insertBefore(wrap, controls);
	} else {
		host.appendChild(wrap);
	}
	syncSwitcherState();
}

function syncSwitcherState() {
	const btns = document.querySelectorAll('.forge-lang-switch__btn');
	for (const btn of btns) {
		const active = btn.dataset.forgeLang === current;
		btn.classList.toggle('is-active', active);
		btn.setAttribute('aria-pressed', active ? 'true' : 'false');
	}
	const wrap = document.querySelector('.forge-lang-switch');
	if (wrap) {
		wrap.title = t('lang.label', 'Language');
	}
}

/* ------------------------------------------------------------------------ welcome screen ---- */

function clickStockEntry(patterns) {
	const links = document.querySelectorAll('.gettingStartedContainer .button-link, .gettingStartedContainer .index-list li a, .gettingStartedContainer .index-list li button');
	for (const link of links) {
		const label = (link.textContent || '').trim().toLowerCase();
		for (const p of patterns) {
			if (label.indexOf(p) !== -1) {
				link.click();
				return true;
			}
		}
	}
	return false;
}

function openAgentPanel() {
	// The agent lives in the auxiliary (right) bar, not the activity bar, so match on the
	// rebranded view-container label wherever its toggle happens to be rendered.
	const item = document.querySelector('a.action-label[aria-label^="FORGE Agent"]')
		|| document.querySelector('.action-item [aria-label^="FORGE Agent"]')
		|| document.querySelector('[aria-label^="FORGE Agent"]');
	if (item) {
		(item.closest('a') || item).click();
		return true;
	}
	return false;
}

function buildHero() {
	const hero = el('div', 'forge-hero');

	const mark = el('div', 'forge-hero__mark');
	const glyph = el('div', 'forge-hero__glyph');
	glyph.setAttribute('aria-hidden', 'true');
	mark.appendChild(glyph);
	mark.appendChild(el('span', 'forge-hero__wordmark', t('brand.name', 'FORGE')));
	mark.appendChild(el('span', 'forge-hero__positioning', t('brand.positioning', 'AI Coding Platform')));
	hero.appendChild(mark);

	const tagline = el('h1', 'forge-hero__tagline', t('welcome.tagline'));
	hero.appendChild(tagline);
	hero.appendChild(el('p', 'forge-hero__subtitle', t('welcome.subtitle')));

	const actions = el('div', 'forge-hero__actions');

	const primary = el('button', 'forge-btn forge-btn--primary', t('welcome.cta.primary'));
	primary.type = 'button';
	primary.addEventListener('click', () => {
		if (!openAgentPanel()) {
			clickStockEntry(['open folder', 'открыть папку']);
		}
	});
	actions.appendChild(primary);

	const secondary = el('button', 'forge-btn forge-btn--ghost', t('welcome.cta.secondary'));
	secondary.type = 'button';
	secondary.addEventListener('click', () => {
		clickStockEntry(['open folder', 'открыть папку']);
	});
	actions.appendChild(secondary);

	const newFile = el('button', 'forge-btn forge-btn--ghost', t('welcome.cta.newFile'));
	newFile.type = 'button';
	newFile.addEventListener('click', () => {
		clickStockEntry(['new file', 'новый файл']);
	});
	actions.appendChild(newFile);

	hero.appendChild(actions);

	const engine = el('div', 'forge-hero__engine');
	const dot = el('span', 'forge-hero__dot');
	dot.setAttribute('aria-hidden', 'true');
	engine.appendChild(dot);
	engine.appendChild(el('span', null, t('welcome.engine', 'Engine') + ': '));
	engine.appendChild(el('b', null, 'MalikLLM 75B'));
	hero.appendChild(engine);

	return hero;
}

function mountWelcomeHero() {
	const containers = document.querySelectorAll('.gettingStartedContainer');
	for (const container of containers) {
		const slot = container.querySelector('.categories-slide-container')
			|| container.querySelector('.gettingStartedCategoriesContainer');
		if (!slot) {
			continue;
		}
		const existing = slot.querySelector(':scope > .forge-hero');
		if (existing) {
			if (existing.dataset.forgeLang !== current) {
				existing.replaceWith(buildHeroTagged());
			}
			continue;
		}
		slot.insertBefore(buildHeroTagged(), slot.firstChild);
		container.classList.add('forge-branded');
	}
}

function buildHeroTagged() {
	const hero = buildHero();
	hero.dataset.forgeLang = current;
	return hero;
}

function localizeWelcomeHeadings() {
	const headings = document.querySelectorAll('.gettingStartedContainer .index-list > h2');
	for (const h of headings) {
		let key = h.dataset.forgeKey;
		if (!key) {
			key = WELCOME_HEADINGS[(h.textContent || '').trim()];
			if (!key) {
				continue;
			}
			h.dataset.forgeKey = key;
		}
		const next = t(key);
		if (h.textContent !== next) {
			h.textContent = next;
		}
	}
}

/* ----------------------------------------------------------------------- agent surfaces ---- */

function localizePlaceholders() {
	const fields = document.querySelectorAll('textarea[placeholder], input[placeholder]');
	for (const field of fields) {
		let key = field.dataset.forgePhKey;
		if (!key) {
			key = PLACEHOLDER_KEYS[field.getAttribute('placeholder') || ''];
			if (!key) {
				continue;
			}
			field.dataset.forgePhKey = key;
		}
		const next = t(key);
		if (field.getAttribute('placeholder') !== next) {
			field.setAttribute('placeholder', next);
		}
	}
}

function localizeAgentTitle() {
	const labels = document.querySelectorAll('.composite.title .title-label h2, .pane-header .title');
	for (const label of labels) {
		const text = (label.textContent || '').trim();
		if (label.dataset.forgeKey !== 'agent.title' && text !== 'FORGE Agent') {
			continue;
		}
		label.dataset.forgeKey = 'agent.title';
		const next = t('agent.title', 'FORGE Agent');
		if (label.textContent !== next) {
			label.textContent = next;
		}
	}
}

/* ------------------------------------------------------------------------------ lifecycle -- */

function applyAll() {
	try { mountLanguageSwitcher(); } catch (e) { /* noop */ }
	try { syncSwitcherState(); } catch (e) { /* noop */ }
	try { mountWelcomeHero(); } catch (e) { /* noop */ }
	try { localizeWelcomeHeadings(); } catch (e) { /* noop */ }
	try { localizePlaceholders(); } catch (e) { /* noop */ }
	try { localizeAgentTitle(); } catch (e) { /* noop */ }
	document.documentElement.setAttribute('lang', current);
}

async function setLanguage(lang) {
	if (SUPPORTED.indexOf(lang) === -1 || lang === current) {
		return;
	}
	try {
		await loadBundle(lang);
	} catch (e) {
		console.error('[FORGE] failed to load locale', lang, e);
		return;
	}
	current = lang;
	storeLanguage(lang);
	applyAll();
}

async function start() {
	current = readStoredLanguage();
	await loadBundle('en');
	if (current !== 'en') {
		try {
			await loadBundle(current);
		} catch (e) {
			current = 'en';
		}
	}

	applyAll();
	// The workbench mounts, re-renders and disposes parts continuously; re-assert on a cheap tick
	// rather than observing the whole document tree.
	mountTimer = setInterval(applyAll, 700);

	globalThis.forge = {
		get language() { return current; },
		setLanguage,
		t,
		stop() { clearInterval(mountTimer); }
	};
	console.log('[FORGE] runtime ready, language =', current);
}

start().catch((e) => console.error('[FORGE] runtime failed', e));
