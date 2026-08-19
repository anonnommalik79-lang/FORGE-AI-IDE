/* FORGE welcome/titlebar layout hotfix.
 * Keeps the stock Getting Started columns intact and removes the duplicated injected hero that
 * can be constrained by VS Code's category column width.
 */

const ICON_URL = new URL('../../resources/win32/code_70x70.png', import.meta.url).href;
let scheduled = false;

function makeBrandBar() {
	const bar = document.createElement('div');
	bar.className = 'forge-welcome-brandbar';
	bar.setAttribute('aria-label', 'FORGE — AI-native IDE');

	const img = document.createElement('img');
	img.className = 'forge-welcome-brandbar__icon';
	img.src = ICON_URL;
	img.alt = '';
	img.setAttribute('aria-hidden', 'true');
	bar.appendChild(img);

	const copy = document.createElement('div');
	copy.className = 'forge-welcome-brandbar__copy';

	const name = document.createElement('div');
	name.className = 'forge-welcome-brandbar__name';
	name.textContent = 'FORGE';
	copy.appendChild(name);

	const sub = document.createElement('div');
	sub.className = 'forge-welcome-brandbar__sub';
	sub.textContent = 'AI-NATIVE IDE';
	copy.appendChild(sub);
	bar.appendChild(copy);

	const engine = document.createElement('div');
	engine.className = 'forge-welcome-brandbar__engine';
	engine.textContent = 'MalikLLM75B';
	bar.appendChild(engine);

	return bar;
}

function mountWelcomeBrand() {
	for (const container of document.querySelectorAll('.gettingStartedContainer')) {
		container.classList.add('forge-welcome-fixed');

		// The previous runtime hero is the element visible in the user's screenshot as clipped/overlapping.
		for (const hero of container.querySelectorAll('.forge-hero')) {
			hero.remove();
		}

		// Hide only the stock top header. Start/Recent lists remain untouched.
		const stockHeaders = container.querySelectorAll('.header');
		if (stockHeaders.length) {
			stockHeaders[0].classList.add('forge-stock-welcome-header');
		}

		if (container.querySelector(':scope > .forge-welcome-brandbar')) {
			continue;
		}

		const bar = makeBrandBar();
		const anchor = Array.from(container.children).find((node) =>
			node.matches?.('.gettingStartedCategoriesContainer, .categories-slide-container, .gettingStartedDetails, .getting-started-container')
		);
		if (anchor) {
			container.insertBefore(bar, anchor);
		} else {
			container.prepend(bar);
		}
	}
}

function mountTitlebarLogo() {
	if (document.querySelector('.forge-titlebar-logo')) {
		return;
	}
	const titlebar = document.querySelector('.part.titlebar');
	if (!titlebar) {
		return;
	}
	const host = titlebar.querySelector('.titlebar-left') || titlebar.querySelector('.titlebar-container') || titlebar;
	const logo = document.createElement('img');
	logo.className = 'forge-titlebar-logo';
	logo.src = ICON_URL;
	logo.alt = 'FORGE';
	logo.title = 'FORGE';
	const menubar = host.querySelector('.menubar');
	if (menubar) {
		host.insertBefore(logo, menubar);
	} else {
		host.prepend(logo);
	}
}

function repair() {
	mountTitlebarLogo();
	mountWelcomeBrand();
}

function scheduleRepair() {
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(() => {
		scheduled = false;
		repair();
	});
}

repair();
const observer = new MutationObserver(scheduleRepair);
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('resize', scheduleRepair, { passive: true });

console.log('[FORGE] compact welcome/titlebar layout hotfix active');
