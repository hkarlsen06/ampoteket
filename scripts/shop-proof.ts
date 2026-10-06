/** Actual SvelteKit/Cloudflare UI acceptance against an owned seeded database. */
import { firefox, expect, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fieldLabel, captureFailure, proofEnvironment, waitForHydration } from './web-proof/harness';
import { generateSeedSql, seedProductId, seedProductCode, seedBinId } from './seed-test-data';
import { readCompleteCatalog } from '../src/lib/catalog';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

const { directory, origin, api, publicKey, safe, sql, startWorker } = await proofEnvironment();
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql(1000));
// Keep all 1,000 active catalog fixtures while leaving one real cabinet unassigned
// for the public map's known-empty selection and no-unnecessary-fetch checks.
await sql(`UPDATE app.products SET bin_id='${seedBinId(0)}' WHERE bin_id IN (
	SELECT b.id FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id WHERE c.outer_row=2 AND c.outer_col=1
);`);
await sql(`UPDATE app.products SET name_nb='220 ohm motstand med et bevisst svært langt komponentnavn for tilgjengelig brytning på smale skjermer og en fullstendig lesbar produktidentitet', name_en='220 ohm resistor with a deliberately long component name for accessible narrow-screen wrapping and a complete, readable product identity' WHERE id='${seedProductId(0)}';`);
const catalogCabinetId = await sql(`SELECT cabinet_id FROM app.bins WHERE id='${seedBinId(0)}'`);
const emptyCabinetId = await sql('SELECT id FROM app.cabinets WHERE outer_row=2 AND outer_col=1');
const topologyUrl = `${api.origin}/rest/v1/rpc/amp_shelf_map`;
// The browser must show the API's complete traversal in order, with every row
// once; supabase/tests own the sort rule (category, primary value, name, code).
async function catalogCodes(indices?: number[]): Promise<string[]> {
	const codes = (await readCompleteCatalog({ url: api.origin, publishableKey: publicKey })).map(product => product.code);
	assert.equal(new Set(codes).size, codes.length, 'The API traversal repeats no part');
	if (!indices) return codes;
	const selected = new Set(indices.map(index => seedProductCode(index)));
	return codes.filter(code => selected.has(code));
}
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const artifacts = resolve('test-results/shop');
await mkdir(artifacts, { recursive: true });
async function documentBox(locator: Locator) {
	return locator.evaluate(element => {
		const box = element.getBoundingClientRect();
		// Firefox rounds viewport and scroll offsets separately. Normalize their
		// subpixel noise while still detecting a one-hundredth CSS-pixel shift.
		const round = (value: number) => Math.round(value * 100) / 100;
		return { x: round(box.x), y: round(box.y + window.scrollY), width: round(box.width), height: round(box.height) };
	});
}
/** Below 48rem the product page starts with its shelf map closed under a disclosure. */
async function openShelfMap(page: Page) {
	if ((page.viewportSize()?.width ?? 1280) >= 768) return;
	// The server renders the disclosure before its client handler is attached.
	await expect(page.locator('#quantity-to-add')).toBeEnabled();
	const trigger = page.locator('#map-title button');
	if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

async function fits(page: Page) {
	const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
	assert.ok(size.content <= size.viewport, `Page overflow at ${size.viewport}px: ${size.content}`);
}
try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const page = await context.newPage();
	const errors: string[] = [];
	const scannerAssets: string[] = [];
	const catalogReads: unknown[] = [];
	page.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (path === '/rest/v1/rpc/amp_catalog') catalogReads.push(request.postDataJSON());
		if (/decoder\.worker-|zxing_reader.*\.wasm$/.test(path)) scannerAssets.push(path);
	});
	page.on('pageerror', (error) => {
		errors.push(error.message);
		console.error('Browser runtime error:', error.message.replaceAll(publicKey, '[redacted]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]'));
	});
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${origin}/en/p`);
	await expect(page.locator('.search-submit')).toBeEnabled({ timeout: 30000 });
	assert.deepEqual(scannerAssets, [], 'Ordinary catalog browsing loads neither the scanner worker nor WASM');
	await expect(page.locator('.filter-toggle')).toBeEnabled();
	assert.deepEqual(catalogReads, [], 'Search is available from the first SSR page without a background catalog traversal');
	const cards = page.locator('ul[aria-label=Parts] > li > [data-slot=card]');
	// Browsing starts with one capped page; only scrolling requests another page.
	await expect(cards).toHaveCount(37);
	const firstCard = await cards.first().elementHandle();
	assert.ok(firstCard);
	const initialCodes = await cards.locator('.product-meta .font-mono').allTextContents();
	const catalogUrl = page.url();
	const beforeAppend = await page.evaluate(() => {
		const pagination = document.querySelector('.pagination')!;
		window.scrollTo(0, pagination.getBoundingClientRect().top + window.scrollY - window.innerHeight + 100);
		return { scroll: window.scrollY, firstTop: document.querySelector('.cards [data-slot=card]')!.getBoundingClientRect().top + window.scrollY };
	});
	await expect(cards).toHaveCount(74);
	const afterAppend = await page.evaluate(() => ({
		scroll: window.scrollY, firstTop: document.querySelector('.cards [data-slot=card]')!.getBoundingClientRect().top + window.scrollY
	}));
	assert.deepEqual(afterAppend, beforeAppend, 'Automatic append preserves the reading position');
	assert.equal(await firstCard.evaluate((element) => element.isConnected), true, 'Existing cards are retained');
	assert.deepEqual((await cards.locator('.product-meta .font-mono').allTextContents()).slice(0, 37), initialCodes);
	assert.equal(page.url(), catalogUrl, 'Automatic append does not navigate or change the URL');
	const appendedPart = cards.nth(50).locator('h2 a');
	await appendedPart.scrollIntoViewIfNeeded();
	const returnScroll = await page.evaluate(() => window.scrollY);
	const appendedHref = await appendedPart.getAttribute('href');
	await appendedPart.click();
	await expect(page).toHaveURL(origin + appendedHref);
	await page.goBack();
	await expect(cards).toHaveCount(74);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(returnScroll);
	// Comparing every row catches skipped or duplicated rows at each 37-row API boundary.
	const expectedCodes = await catalogCodes();
	assert.equal(expectedCodes.length, 1000);
	for (let count = 74; count < expectedCodes.length;) {
		await page.evaluate(() => {
			const pagination = document.querySelector('.pagination')!;
			window.scrollTo(0, pagination.getBoundingClientRect().top + window.scrollY - window.innerHeight + 100);
		});
		count = Math.min(count + 37, expectedCodes.length);
		await expect(cards).toHaveCount(count);
	}
	assert.deepEqual(await cards.locator('.product-meta .font-mono').allTextContents(), expectedCodes);
	assert.equal(page.url(), catalogUrl);
	await expect(page.getByRole('link', { name: 'Show more', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Filters', exact: true }).click();
	const filterDialog = page.getByRole('dialog', { name: 'Filter parts', exact: true });
	await filterDialog.getByRole('checkbox', { name: 'Resistor', exact: true }).check();
	await filterDialog.getByRole('checkbox', { name: 'Capacitor', exact: true }).check();
	await filterDialog.getByRole('button', { name: 'Show results', exact: true }).click();
	await expect(filterDialog).toBeHidden();
	await expect(page).toHaveURL(`${origin}/en/p?category=Resistors&category=Capacitors`);
	await expect(cards).toHaveCount(37);
	assert.deepEqual(await cards.locator('.product-meta .font-mono').allTextContents(),
		expectedCodes.filter((code) => code.startsWith('RES-') || code.startsWith('CAP-')).slice(0, 37));
	console.log('PASS: infinite scrolling retains SSR rows, order, URL and reading position, including Back; reaches all 1,000 parts; filtering resets the visible batch');

	await page.goto(`${origin}/en/p?category=Capacitors&eq.capacitance=0.000000000005`);
	await expect(page.locator(`a[href='/en/p/${seedProductCode(5)}']`)).toBeVisible({ timeout: 30000 });
	await expect(page.locator(`a[href='/en/p/${seedProductCode(6)}']`)).toHaveCount(0);
	assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'https://ampoteket.no/en/p');
	// The filter form must fit a short phone viewport while only its named
	// options region scrolls. Slider values remain exact SI text after cancellation.
	await page.setViewportSize({ width: 360, height: 640 });
	await page.locator('.filter-toggle').click();
	const shortDialog = page.getByRole('dialog', { name: en.catalog.filterTitle, exact: true });
	const shortApply = shortDialog.getByRole('button', { name: en.catalog.applyFilters, exact: true });
	const shortApplyBox = await shortApply.boundingBox();
	assert.ok(shortApplyBox && shortApplyBox.y >= 0 && shortApplyBox.y + shortApplyBox.height <= 640,
		'Filter actions remain visible at 360x640');
	const options = shortDialog.getByRole('region', { name: en.catalog.filterOptions, exact: true });
	assert.ok(await options.evaluate(element => element.scrollHeight > element.clientHeight),
		'Long filter options use the named interior scroll region');
	await options.focus();
	await options.press('End');
	await expect.poll(() => options.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	const capacitanceUpper = shortDialog.locator('#max-capacitance');
	await expect(capacitanceUpper).toHaveAttribute('aria-label', en.catalog.max);
	await expect(capacitanceUpper).toHaveAttribute('aria-valuetext', '5 pF');
	await capacitanceUpper.press('End');
	await expect(capacitanceUpper).toHaveAttribute('aria-valuetext', en.catalog.noUpperBound);
	await page.keyboard.press('Escape');
	await expect(shortDialog).toBeHidden();
	await expect(page.locator('.filter-toggle')).toBeFocused();
	await page.locator('.filter-toggle').click();
	await expect(shortDialog.locator('#max-capacitance')).toHaveAttribute('aria-valuetext', '5 pF');
	await shortDialog.getByRole('button', { name: en.catalog.cancel, exact: true }).click();
	await expect(shortDialog).toBeHidden();
	await expect(page.locator('.filter-toggle')).toBeFocused();
	await expect(page).toHaveURL(`${origin}/en/p?category=Capacitors&eq.capacitance=0.000000000005`);
	await page.setViewportSize({ width: 1280, height: 900 });
	console.log('PASS: short phone filters keep actions visible, scroll by keyboard, announce exact slider values and restore cancelled drafts/focus');
	// A shared cabinet link still pages and restores through Back.
	await page.goto(`${origin}/en/p?cabinet=${catalogCabinetId}`);
	await expect(cards).toHaveCount(37);
	await page.evaluate(() => {
		const pagination = document.querySelector('.pagination')!;
		window.scrollTo(0, pagination.getBoundingClientRect().top + window.scrollY - window.innerHeight + 100);
	});
	await expect(cards).toHaveCount(74);
	assert.deepEqual(await cards.locator('.product-meta .font-mono').allTextContents(), expectedCodes.slice(0, 74));
	expect(catalogReads.at(-1)).toMatchObject({ p_cabinet_ids: [catalogCabinetId] });
	await cards.nth(50).locator('h2 a').click();
	await expect(page).toHaveURL(`${origin}/en/p/${expectedCodes[50]}`);
	await page.goBack();
	await expect(page).toHaveURL(`${origin}/en/p?cabinet=${catalogCabinetId}`);
	await expect(cards).toHaveCount(74);
	// Tapping a drawer is a new search by placement: no checkboxes, no apply step.
	await page.goto(`${origin}/en/p?q=transistor&category=Resistors`);
	const locationDialog = page.getByRole('dialog', { name: en.catalog.location, exact: true });
	await page.locator('.location-toggle').click();
	await expect(locationDialog.getByRole('button', { name: en.catalog.applyFilters, exact: true })).toHaveCount(0);
	await expect(locationDialog.getByRole('checkbox')).toHaveCount(0);
	await expect(locationDialog.getByRole('button', { name: en.adminLabels.clearSelection, exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(locationDialog).toBeHidden();
	await expect(page.locator('.location-toggle')).toBeFocused();
	await page.locator('.location-toggle').click();
	await locationDialog.getByRole('button', { name: en.adminLabels.cabinet('A1'), exact: true }).click();
	await locationDialog.locator(`[data-item-id='${seedBinId(0)}']`).click();
	await expect(locationDialog).toBeHidden();
	await expect(page).toHaveURL(`${origin}/en/p?bin=${seedBinId(0)}`);
	const drawerCodes = await catalogCodes(Array.from({ length: 1000 }, (_, index) => index).filter(index => index % 30 === 0));
	await expect(cards).toHaveCount(drawerCodes.length);
	assert.deepEqual(await cards.locator('.product-meta .font-mono').allTextContents(), drawerCodes);
	await expect(page.locator('.location-toggle')).toHaveText(en.catalog.locationSelected(1));
	await page.getByLabel(fieldLabel(en.catalog.searchLabel)).fill('220 ohm');
	await page.getByRole('button', { name: en.catalog.search, exact: true }).click();
	await expect(page).toHaveURL(url => url.searchParams.get('q') === '220 ohm' && url.searchParams.get('bin') === seedBinId(0));
	await expect(cards).toHaveCount(drawerCodes.length);
	await page.locator('.menu-toggle').click();
	await page.locator('header a[hreflang=nb]').click();
	await expect(page).toHaveURL(url => url.pathname === '/p' && url.searchParams.get('bin') === seedBinId(0) && url.searchParams.get('q') === '220 ohm');
	await page.goto(`${origin}/en/p?bin=${seedBinId(0)}&q=220%20ohm`);
	// The map reopens on the drawer's cabinet; clearing keeps the text search.
	await page.locator('.location-toggle').click();
	await expect(locationDialog.locator(`[data-item-id='${seedBinId(0)}']`)).toHaveAttribute('aria-pressed', 'true');
	await locationDialog.getByRole('button', { name: en.adminLabels.clearSelection, exact: true }).click();
	await expect(locationDialog).toBeHidden();
	await expect(page).toHaveURL(`${origin}/en/p?q=220+ohm`);
	await page.goto(`${origin}/en/p?bin=${seedBinId(0)}&category=Capacitors`);
	await expect(page.getByText(en.catalog.noMatches, { exact: true })).toBeVisible();
	await page.goto(`${origin}/en/p?cabinet=${emptyCabinetId}&q=${seedProductCode(0)}`);
	await expect(page.getByText(en.catalog.noMatches, { exact: true })).toBeVisible();
	await expect(page).toHaveURL(url => url.pathname === '/en/p' && url.searchParams.get('cabinet') === emptyCabinetId);
	await page.goto(`${origin}/en/p?bin=ffffffff-ffff-4fff-8fff-ffffffffffff`);
	await expect(page.getByText(en.catalog.noMatches, { exact: true })).toHaveCount(0);
	await page.goto(`${origin}/en/p`);
	await page.route(topologyUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
	await page.locator('.location-toggle').click();
	await expect(locationDialog.getByText(en.shelfMap.unavailable, { exact: true })).toBeVisible();
	await page.unroute(topologyUrl);
	await locationDialog.getByRole('button', { name: en.catalog.retry, exact: true }).click();
	await expect(locationDialog.getByRole('button', { name: en.adminLabels.cabinet('A1'), exact: true })).toBeEnabled();
	await page.keyboard.press('Escape');
	console.log('PASS: a tapped drawer opens its parts as a new search; shared cabinet links page and restore via Back; the map reopens on the drawer, clears without losing text, keeps locale, and recovers from failed topology reads');
	await page.goto(`${origin}/en/p?code=${seedProductCode(0).toLowerCase()}`);
	await expect(page).toHaveURL(`${origin}/en/p/${seedProductCode(0)}`);
	// Unified search: a query that is exactly one existing part code opens the
	// part directly; a code-shaped query without a matching part stays a search.
	await page.goto(`${origin}/en/p?q=${seedProductCode(0).toLowerCase()}`);
	await expect(page).toHaveURL(`${origin}/en/p/${seedProductCode(0)}`);
	await page.goto(`${origin}/en/p?q=ZZZ-00000`);
	await expect(page).toHaveURL(`${origin}/en/p?q=ZZZ-00000`);
	await expect(page.getByText(en.catalog.noMatches, { exact: true })).toBeVisible({ timeout: 60000 });
	await page.goto(`${origin}/en/p?code=${seedProductCode(0).toLowerCase()}`);
	await expect(page).toHaveURL(`${origin}/en/p/${seedProductCode(0)}`);
	await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
	await page.getByLabel(fieldLabel(en.product.quantity)).fill('2');
	await page.getByLabel(fieldLabel(en.product.quantity)).press('Enter');
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity)).toBe('2');
	await expect(page.locator('.header-cart [data-slot=badge]')).toHaveText('1');
	console.log('PASS: actual catalog filters beyond page one, exact 5pF matching, code redirect and product addition');

	const second = await context.newPage();
	await second.goto(`${origin}/en/p/${seedProductCode(0)}`);
	await expect(second.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
	await page.getByLabel(fieldLabel(en.product.quantity)).fill('3');
	await second.getByLabel(fieldLabel(en.product.quantity)).fill('4');
	await Promise.all([page.getByRole('button', { name: 'Add to cart', exact: true }).click(), second.getByRole('button', { name: 'Add to cart', exact: true }).click()]);
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity)).toBe('9');
	await page.goto(`${origin}/en/cart`);
	await expect(page.locator('input[inputmode=decimal]').first()).toHaveValue('9');
	await page.reload();
	await expect(page.locator('input[inputmode=decimal]').first()).toHaveValue('9');
	await page.goto(`${origin}/cart`);
	await expect(page.locator('input[inputmode=decimal]').first()).toHaveValue('9');
	await expect(page.locator('.header-cart [data-slot=badge]')).toHaveText('1');
	console.log('PASS: simultaneous tabs merge quantities; cart and header survive reload and locale changes');
	await page.goto(`${origin}/en/cart`);
	await expect(page.locator('input[inputmode=decimal]').first()).toBeEnabled();
	await page.locator('input[inputmode=decimal]').first().fill('10');
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity)).toBe('10');
	await expect(page.locator('.cart-line button[type=submit]')).toHaveCount(0);
	await expect(page.locator('.cart-line .remove svg')).toHaveCount(1);
	await page.locator('input[inputmode=decimal]').first().fill('');
	await page.locator('input[inputmode=decimal]').first().press('Tab');
	await expect(page.locator('input[inputmode=decimal]').first()).toHaveAttribute('aria-invalid', 'true');
	assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity), '10');
	await page.locator('input[inputmode=decimal]').first().fill('11');
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity)).toBe('11');
	console.log('PASS: cart quantities save without submitting; invalid drafts preserve the saved quantity; removal uses an accessible trash icon');

	await page.goto(`${origin}/en/p/${seedProductCode(29)}`);
	await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
	await page.getByLabel(fieldLabel(en.product.quantity)).fill('0.3');
	await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]').find((line: { code: string }) => line.code === 'CAB-0001E')?.quantity)).toBe('0.3');
	await page.getByLabel(fieldLabel(en.product.quantity)).fill('0.25');
	await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
	await expect(page.getByLabel(fieldLabel(en.product.quantity))).toHaveAttribute('aria-invalid', 'true');
	await expect(page.locator('#quantity-result')).toContainText(en.cart.errors.quantity);
	assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]').find((line: { code: string }) => line.code === 'CAB-0001E')?.quantity), '0.3');

	const mapMessages = en.shelfMap;
	const browser = context.browser()!;
	const drawerCatalogUrl = `${api.origin}/rest/v1/rpc/amp_catalog`;
	for (const [locale, messages] of [['', nb], ['/en', en]] as const) for (const reducedMotion of ['reduce', 'no-preference'] as const) {
		await page.emulateMedia({ reducedMotion });
		for (const viewport of [{ width: 667, height: 375 }, { width: 844, height: 390 }]) {
			await page.setViewportSize(viewport);
			await page.goto(origin + (locale || '/'));
			await page.evaluate(() => document.fonts.ready);
			const hero = page.locator('section[aria-labelledby="hero-title"]');
			for (const content of [hero.locator('#hero-title'), hero.getByText(messages.home.hero.lede, { exact: true }), hero.getByRole('link', { name: messages.home.hero.parts, exact: true })]) {
				await content.scrollIntoViewIfNeeded();
				await expect(content).toBeInViewport({ ratio: 1 });
			}
			await fits(page);
		}
	}
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	for (const [locale, messages] of [['', nb], ['/en', en]] as const) {
		await page.setViewportSize({ width: 360, height: 900 });
		await page.goto(origin + (locale || '/'));
		await page.evaluate(() => document.fonts.ready);
		const hero = page.locator('section[aria-labelledby="hero-title"]');
		const catalog = hero.getByRole('link', { name: messages.home.hero.parts, exact: true });
		await expect(hero).toHaveAttribute('data-walk-fits', 'true');
		try {
			await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
			await expect.poll(() => hero.getAttribute('data-walk-fits')).toBeNull();
			for (const content of [hero.locator('#hero-title'), hero.getByText(messages.home.hero.lede, { exact: true }), catalog]) {
				assert.ok(await content.evaluate(element => {
					const frame = document.getElementById('hero-title')!.parentElement!.parentElement!.getBoundingClientRect();
					const box = element.getBoundingClientRect();
					return box.left >= frame.left && box.right <= frame.right && box.top >= frame.top && box.bottom <= frame.bottom;
				}), 'Enlarged hero copy and actions remain inside the first row');
			}
			await catalog.scrollIntoViewIfNeeded();
			await catalog.focus();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(catalog).toBeFocused();
			await expect(catalog).toBeInViewport({ ratio: 1 });
		} finally { await page.evaluate(() => document.documentElement.style.removeProperty('font-size')); }
		await expect(hero).toHaveAttribute('data-walk-fits', 'true');
	}
	console.log('PASS: landscape and enlarged-text hero copy/actions remain reachable; motion eligibility returns after font restoration');
	// The home picker has no current product. Its contents come from a complete
	// drawer-scoped catalog read only after a visitor selects an assigned drawer.
	const homeDrawerCodes = await catalogCodes(Array.from({ length: 1000 }, (_, index) => index).filter(index => index % 30 === 0));
	for (const locale of ['', '/en']) for (const colour of ['light', 'dark'] as const) for (const width of [360, 1280]) {
		const messages = locale ? en : nb;
		const height = width === 360 ? 640 : 900;
		const homeContext = await browser.newContext({ viewport: { width, height }, colorScheme: colour });
		const homePage = await homeContext.newPage();
		homePage.on('pageerror', error => errors.push(error.message));
		const homeCatalogRequests: string[] = [];
		homePage.on('request', request => { if (request.url() === drawerCatalogUrl) homeCatalogRequests.push(request.postData() ?? ''); });
		const exerciseRecovery = !locale && colour === 'light' && width === 360;
		if (exerciseRecovery) await homeContext.route(topologyUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
		try {
			await homePage.goto(origin + (locale || '/'));
			const homeMap = homePage.locator('.shelf-map');
			const shelfOpen = homePage.getByRole('button', { name: messages.home.find.shelfOpen, exact: true });
			const homeSheet = homePage.getByRole('dialog', { name: messages.home.find.shelfTitle, exact: true });
			await expect(homeMap).toHaveCount(0);
			await shelfOpen.scrollIntoViewIfNeeded();
			await homePage.evaluate(() => document.fonts.ready);
			const codeFormBefore = await documentBox(homePage.locator('.code-form'));
			await shelfOpen.click();
			await expect(homeSheet.getByRole('heading', { name: messages.home.find.shelfTitle, exact: true })).toBeVisible();
			const shelfClose = homeSheet.getByRole('button', { name: messages.home.find.shelfClose, exact: true });
			const shelfBody = homeSheet.locator('.shelf-picker-body');
			await expect(shelfBody).toHaveAttribute('role', 'region');
			await expect(shelfBody).toHaveAttribute('tabindex', '0');
			await expect(shelfBody).toHaveAccessibleName(/\S/);
			if (exerciseRecovery) {
				await homePage.evaluate(() => window.dispatchEvent(new Event('online')));
				// Every read has failed so far; there is no previous topology to retain.
				await expect(homeMap.getByText(messages.shelfMap.unavailable, { exact: true })).toBeVisible();
				await expect(homeMap.getByText(messages.shelfMap.previousRead, { exact: true })).toHaveCount(0);
				await expect(homeMap.getByText(messages.shelfMap.noProducts, { exact: true })).toHaveCount(0);
				await expect(homePage.getByRole('button', { name: messages.home.find.codeSubmit, exact: true, includeHidden: true })).toBeEnabled();
				await homeContext.unroute(topologyUrl);
				await homeMap.getByRole('button', { name: messages.shelfMap.retry, exact: true }).click();
			}
			const homeWall = homeMap.getByRole('group', { name: messages.shelfMap.wall, exact: true });
			await expect(homeWall.getByRole('button')).toHaveCount(12);
			if (exerciseRecovery) {
				// A later failed refresh must retain the successfully loaded wall.
				await homeContext.route(topologyUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
				await homePage.evaluate(() => window.dispatchEvent(new Event('online')));
				await expect(homeMap.getByText(messages.shelfMap.previousRead, { exact: true })).toBeVisible();
				await expect(homeMap.getByText(messages.shelfMap.unavailable, { exact: true })).toHaveCount(0);
				await expect(homeWall.getByRole('button')).toHaveCount(12);
				await homeContext.unroute(topologyUrl);
				await homeMap.getByRole('button', { name: messages.shelfMap.retry, exact: true }).click();
				await expect(homeMap.getByText(messages.shelfMap.previousRead, { exact: true })).toHaveCount(0);
			}
			await expect(homeMap.locator('.drawer-contents, .loc, [aria-current], [aria-pressed="true"]')).toHaveCount(0);
			await expect(homeMap.getByText(messages.shelfMap.locationUnavailable, { exact: true })).toHaveCount(0);
			assert.deepEqual(homeCatalogRequests, [], 'The homepage reads topology without traversing the catalog');
			// The stage shows one level at a time: record wall geometry before zooming in.
			const wallDiagramBox = await documentBox(homeWall);
			const wallFrameBox = await documentBox(homeWall.locator('.cabinet-frame'));
			const cabinetFaceBox = await documentBox(homeWall.locator('.drawer').first());
			const showWall = homeMap.getByRole('button', { name: messages.shelfMap.showWall, exact: true });
			const selectionPageScroll = await homePage.evaluate(() => window.scrollY);
			await homeWall.getByRole('button', { name: 'A2', exact: true }).click();
			const homeEmpty = homeMap.getByRole('group', { name: messages.shelfMap.cabinet('A2'), exact: true });
			await expect(homeEmpty.getByRole('button')).toHaveCount(24);
			await expect(homeWall).toHaveCount(0);
			await expect(homeMap.locator('.stage').getByRole('heading', { name: messages.shelfMap.cabinet('A2'), exact: true })).toBeFocused();
			await expect(homeMap.locator('.stage').getByRole('heading')).toBeInViewport();
			assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
				'Cabinet selection reveals drawers without moving the document');
			await homeEmpty.getByRole('button', { name: `A1 · ${messages.shelfMap.emptyDrawer}`, exact: true }).click();
			await expect(homeMap.getByText(messages.shelfMap.noProducts, { exact: true })).toBeVisible();
			await expect(homeMap.locator('.drawer-contents').getByRole('heading')).toBeInViewport();
			assert.deepEqual(homeCatalogRequests, [], 'A known empty homepage drawer needs no catalog read');
			await showWall.click();
			await expect(homeWall.getByRole('button', { name: 'A2', exact: true })).toBeFocused();
			await expect(homeMap.locator('.drawer-contents')).toHaveCount(0);
			await homeWall.getByRole('button', { name: 'A1', exact: true }).click();
			const homeCabinet = homeMap.getByRole('group', { name: messages.shelfMap.cabinet('A1'), exact: true });
			const homeDrawer = homeCabinet.getByRole('button', { name: 'A1', exact: true });
			await homeCabinet.getByRole('button').first().focus();
			const beforeArrowScroll = await homePage.evaluate(() => window.scrollY);
			await homePage.keyboard.press('End');
			await expect(homeCabinet.getByRole('button').last()).toBeFocused();
			assert.ok(await shelfBody.evaluate(element => {
				const target = document.activeElement!.getBoundingClientRect(), frame = element.getBoundingClientRect();
				return target.top >= frame.top && target.bottom <= frame.bottom;
			}), 'Roving keyboard focus stays visible inside the shelf scroll region');
			assert.equal(await homePage.evaluate(() => window.scrollY), beforeArrowScroll,
				'Roving drawer focus scrolls the shelf body without moving the document');
			if (exerciseRecovery) await homeContext.route(drawerCatalogUrl, async route => {
				if (route.request().postDataJSON().p_after_code) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
				else await route.continue();
			});
			await homeDrawer.click();
			if (exerciseRecovery) {
				await expect(homeMap.getByText(messages.shelfMap.productsUnavailable, { exact: true })).toBeVisible();
				await expect(homeMap.getByText(messages.shelfMap.noProducts, { exact: true })).toHaveCount(0);
				await expect(homeMap.locator('.product-list')).toHaveCount(0);
				await homeContext.unroute(drawerCatalogUrl);
				await homeMap.getByRole('button', { name: messages.shelfMap.retryProducts, exact: true }).click();
			}
			const homeProducts = homeMap.locator('.product-list a');
			await expect(homeProducts).toHaveCount(homeDrawerCodes.length, { timeout: 30000 });
			await expect.poll(() => homeMap.locator('.drawer-contents').evaluate(element => {
				const frame = element.closest('.shelf-picker-body')!.getBoundingClientRect();
				return Math.abs(element.getBoundingClientRect().top - frame.top);
			})).toBeLessThanOrEqual(24);
			assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
				'Loaded drawer contents scroll into the sheet without moving the document');
			assert.deepEqual(await homeProducts.evaluateAll(links => links.map(link => link.getAttribute('href'))),
				homeDrawerCodes.map(code => `${locale}/p/${code}`), 'Every assigned product is linked in catalog order, including products beyond the API cap');
			await expect(homeProducts.first()).toContainText(locale ? 'resistor' : 'motstand');
			for (const [index, code] of homeDrawerCodes.entries()) await expect(homeProducts.nth(index)).toContainText(code);
			await expect(homeProducts.locator('svg[aria-hidden="true"]')).toHaveCount(homeDrawerCodes.length);
			await expect(homeDrawer).toHaveAttribute('aria-pressed', 'true');
			await expect(homeMap.locator('[aria-current]')).toHaveCount(0);
			assert.deepEqual(await documentBox(homePage.locator('.code-form')), codeFormBefore, 'Drawer disclosure leaves code entry in place');
			const contentsBox = await documentBox(homeMap.locator('.drawer-contents'));
			const firstProductBox = await documentBox(homeProducts.first());
			const contentsHeadingBox = await documentBox(homeMap.locator('.drawer-contents').getByRole('heading'));
			assert.ok(contentsBox.width > 0 && firstProductBox.x >= contentsBox.x
				&& firstProductBox.x + firstProductBox.width <= contentsBox.x + contentsBox.width + 0.5,
				'Drawer products remain inside their content section');
			expect(firstProductBox.width).toBeCloseTo(contentsBox.width, 0);
			assert.ok(firstProductBox.height >= 44, 'The whole product card is a comfortable link target');
			assert.ok(firstProductBox.y >= contentsHeadingBox.y + contentsHeadingBox.height
				&& firstProductBox.y - contentsHeadingBox.y - contentsHeadingBox.height < 48,
				'Drawer products follow their heading without a detached grid row');
			const cabinetFrameBox = await documentBox(homeCabinet.locator('.cabinet-frame'));
			expect(cabinetFaceBox.width / cabinetFaceBox.height).toBeCloseTo(cabinetFrameBox.width / cabinetFrameBox.height, 2);
			assert.ok(wallDiagramBox.width <= 384, 'The homepage wall stays compact at desktop widths');
			assert.ok(cabinetFrameBox.width <= wallFrameBox.width, 'The opened cabinet is no wider than the wall graphic');
			const homeHitboxes = await homeMap.locator('.cell-hit').evaluateAll(elements => elements.map(element => {
				const box = element.getBoundingClientRect(); return { width: box.width, height: box.height };
			}));
			assert.equal(homeHitboxes.length, 48);
			for (const box of homeHitboxes) assert.ok(box.width >= 24 && box.height >= 24,
				`Homepage map target is at least 24px at ${width}px: ${JSON.stringify(box)}`);
			if (exerciseRecovery) {
				const contentsBefore = await homeMap.locator('.product-list').innerText();
				await homeDrawer.focus();
				const focusedDrawer = await homeDrawer.elementHandle();
				const beforeRefreshScroll = await shelfBody.evaluate(element => element.scrollTop);
				let releaseHomeRefresh!: () => void, homeRefreshRequests = 0;
				const homeRefreshGate = new Promise<void>(resolve => { releaseHomeRefresh = resolve; });
				await homeContext.route(topologyUrl, async route => {
					homeRefreshRequests++;
					const response = await route.fetch();
					await homeRefreshGate;
					await route.fulfill({ response });
				});
				try {
					await homePage.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
					await expect.poll(() => homeRefreshRequests).toBe(1);
					await expect(homeDrawer).toBeFocused();
					assert.equal(await homeMap.locator('.product-list').innerText(), contentsBefore);
					const homeRefreshed = homePage.waitForResponse(topologyUrl);
					const contentsRefreshed = homePage.waitForResponse(response => response.url() === drawerCatalogUrl
						&& response.request().postDataJSON().p_after_code === homeDrawerCodes.at(-1));
					releaseHomeRefresh(); await homeRefreshed;
					await (await contentsRefreshed).finished();
					await homePage.evaluate(() => new Promise(requestAnimationFrame));
					await expect(homeDrawer).toHaveAttribute('aria-pressed', 'true');
					await expect(homeDrawer).toBeFocused();
					assert.equal(await focusedDrawer!.evaluate(element => element.isConnected), true);
					assert.equal(await homeMap.locator('.product-list').innerText(), contentsBefore);
					assert.equal(await shelfBody.evaluate(element => element.scrollTop), beforeRefreshScroll,
						'Background topology and contents refreshes preserve the sheet reading position');
					assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll);
				} finally { releaseHomeRefresh(); await homeContext.unroute(topologyUrl); }
			}
			assert.ok(await shelfBody.evaluate(element => element.scrollWidth <= element.clientWidth),
				'The shelf scroll region has no horizontal overflow');
			await shelfBody.focus();
			await shelfBody.press('End');
			await expect.poll(() => shelfBody.evaluate(element =>
				Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
			assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
				'Keyboard scrolling the sheet leaves the document in place');
			const closeBox = await shelfClose.boundingBox();
			assert.ok(closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= height,
				'The shelf close control stays visible while its contents scroll');
			const selectedDrawer = await homeDrawer.elementHandle();
			const pageScroll = await homePage.evaluate(() => window.scrollY);
			await homePage.keyboard.press('Escape');
			await expect(homeSheet).toBeHidden();
			await expect(shelfOpen).toBeFocused();
			await expect(homeMap).toHaveCount(1);
			await expect(homeMap).toBeHidden();
			assert.equal(await homePage.evaluate(() => window.scrollY), pageScroll, 'Closing the shelf preserves the page reading position');
			assert.deepEqual(await documentBox(homePage.locator('.code-form')), codeFormBefore, 'Opening and closing the shelf leaves code entry in place');
			// Wait for the fading overlay so Playwright does not retry the blocked
			// trigger click with a different document scroll alignment.
			await expect(homePage.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
			await shelfOpen.click();
			await expect(homeSheet).toBeVisible();
			assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
				'Reopening the populated sheet leaves the document in place');
			await expect(homeDrawer).toHaveAttribute('aria-pressed', 'true');
			await expect(homeProducts).toHaveCount(homeDrawerCodes.length);
			assert.equal(await selectedDrawer!.evaluate(element => element.isConnected), true, 'Reopening the shelf retains the selected drawer node');
			if (exerciseRecovery) {
				await showWall.click();
				await homeWall.getByRole('button', { name: 'A1', exact: true }).click();
				assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
					'Reselecting the cabinet leaves the document in place');
				let releaseContents!: () => void, pendingContents = false;
				const contentsGate = new Promise<void>(resolve => { releaseContents = resolve; });
				await homeContext.route(drawerCatalogUrl, async route => {
					const response = await route.fetch(); pendingContents = true;
					await contentsGate;
					await route.fulfill({ response });
				});
				try {
					await homeDrawer.click();
					await expect.poll(() => pendingContents).toBe(true);
					await shelfBody.focus(); await shelfBody.press('Home');
					await expect.poll(() => shelfBody.evaluate(element => element.scrollTop)).toBe(0);
					assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
						'Returning to the sheet top during a pending read leaves the document in place');
					await homePage.keyboard.press('Escape');
					await expect(homeSheet).toBeHidden();
					await expect(shelfOpen).toBeFocused();
					assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
						'Closing the sheet during a pending read leaves the document in place');
					await expect(homePage.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
					await shelfOpen.click();
					await expect(homeSheet).toBeVisible();
					assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll,
						'Reopening the sheet during a pending read leaves the document in place');
					releaseContents();
					await expect(homeProducts).toHaveCount(homeDrawerCodes.length);
					await homePage.evaluate(() => new Promise(requestAnimationFrame));
					assert.equal(await shelfBody.evaluate(element => element.scrollTop), 0,
						'Closing the sheet cancels pending selection scrolling, including results arriving after reopening');
					assert.equal(await homePage.evaluate(() => window.scrollY), selectionPageScroll);
				} finally { releaseContents(); await homeContext.unroute(drawerCatalogUrl); }
			}
			await fits(homePage);
			await shelfBody.focus();
			await shelfBody.press('Home');
			await expect.poll(() => shelfBody.evaluate(element => element.scrollTop)).toBe(0);
			await homeSheet.screenshot({ path: `${artifacts}/home-shelf-${locale ? 'en' : 'nb'}-${colour}-${width}.png` });
			await homeProducts.last().click();
			await expect(homePage).toHaveURL(`${origin}${locale}/p/${homeDrawerCodes.at(-1)}`);
			await expect(homePage.locator('.shelf-map .stage [data-item-id][aria-current="true"]')).toHaveAttribute('aria-label', 'A1');
			await homePage.goto(origin + (locale || '/'));
			// Above 40rem the scanner is a header-menu row.
			await expect(homePage.locator('.scanner-trigger')).toBeEnabled({ timeout: 30000 });
			if (!await homePage.locator('.scanner-trigger').isVisible()) await homePage.locator('.menu-toggle').click();
			await expect(homePage.getByRole('button', { name: messages.scanner.open, exact: true })).toHaveCount(1);
			await homePage.getByRole('button', { name: messages.scanner.open, exact: true }).click();
			await expect(homePage).toHaveURL(origin + (locale || '/'));
			await expect(homePage.getByRole('dialog', { name: messages.scanner.title, exact: true })).toBeVisible();
			await expect(homePage.locator('.scanner-dialog form.manual')).toBeVisible();
			await fits(homePage);
		} catch (error) { await captureFailure(homePage, artifacts, `home-${locale ? 'en' : 'nb'}-${colour}-${width}`); throw error; }
		finally { await homeContext.close(); }
	}
	console.log('PASS: homepage shelf sheet in both locales/themes at 360/1280px; selection scrolling, full-width product links, empty/unavailable/retry states, keyboard access and retained selection; refresh and closed pending reads preserve scroll');

	// Hold a topology revalidation; the exact initial wall geometry is rendered on the server.
	for (const width of [360, 1280]) {
		const delayed = await browser.newContext({ viewport: { width, height: 900 } });
		const delayedPage = await delayed.newPage();
		delayedPage.on('pageerror', error => errors.push(error.message));
		let release!: () => void, intercepted = false;
		const responseGate = new Promise<void>(resolve => { release = resolve; });
		await delayed.route(topologyUrl, async route => {
			intercepted = true;
			const response = await route.fetch();
			await responseGate;
			await route.fulfill({ response }).catch(() => { /* Navigation may cancel this held response. */ });
		});
		try {
			await delayedPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
			await waitForHydration(delayedPage);
			await delayedPage.evaluate(() => window.dispatchEvent(new Event('online')));
			await expect.poll(() => intercepted).toBe(true);
			await expect(delayedPage.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
			await delayedPage.evaluate(() => document.fonts.ready);
			const quantity = delayedPage.getByLabel(fieldLabel(en.product.quantity));
			const add = delayedPage.getByRole('button', { name: 'Add to cart', exact: true });
			// Below 48rem the product page starts with its shelf map closed under a disclosure.
			await openShelfMap(delayedPage);
			const quantityBefore = await documentBox(quantity), addBefore = await documentBox(add);
			await expect(delayedPage.locator('.shelf-map .stage .shelf-diagram')).toBeVisible();
			const stageBefore = await documentBox(delayedPage.locator('.shelf-map .stage'));
			const refreshed = delayedPage.waitForResponse(topologyUrl);
			release(); await refreshed;
			await expect(delayedPage.locator('.shelf-map .stage [data-item-id][aria-current="true"]')).toHaveCount(1);
			for (const [before, after] of [[quantityBefore, await documentBox(quantity)], [addBefore, await documentBox(add)], [stageBefore, await documentBox(delayedPage.locator('.shelf-map .stage'))]]) {
				for (const key of ['x', 'y', 'width', 'height'] as const) expect(after[key]).toBeCloseTo(before[key], 2);
			}
			await fits(delayedPage);
		} catch (error) { await captureFailure(delayedPage, artifacts, `delayed-${width}`); throw error; }
		finally { release(); await delayed.close(); }
	}
	console.log('PASS: automatic shelf-map loading preserves quantity and Add geometry while real topology is delayed at phone and desktop widths');

	const interactive = await browser.newContext({ hasTouch: true, viewport: { width: 360, height: 900 } });
	const mapPage = await interactive.newPage();
	mapPage.on('pageerror', error => errors.push(error.message));
	const drawerCatalogRequests: string[] = [];
	mapPage.on('request', request => { if (request.url() === `${api.origin}/rest/v1/rpc/amp_catalog`) drawerCatalogRequests.push(request.url()); });
	await mapPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
	await openShelfMap(mapPage);
	const publicMap = mapPage.locator('.shelf-map');
	const wall = publicMap.getByRole('group', { name: mapMessages.wall, exact: true });
	const showWall = publicMap.getByRole('button', { name: mapMessages.showWall, exact: true });
	// The product page opens zoomed into the product's cabinet; the wall is one tap out.
	await expect(publicMap.getByRole('group', { name: mapMessages.cabinet('A1'), exact: true })).toBeVisible();
	await expect(wall).toHaveCount(0);
	await expect(publicMap.locator('.coordinate-list, .levels button[aria-expanded]')).toHaveCount(0);
	await expect(publicMap.locator('button:not([data-item-id]):not([aria-expanded])')).toHaveCount(1);
	await expect(publicMap.locator('.stage button[data-item-id][tabindex="0"]')).toHaveCount(1);
	await expect(publicMap.locator('.stage [data-item-id][aria-current="true"]')).toHaveAttribute('aria-label', 'A1');
	await expect(publicMap.getByRole('heading', { name: mapMessages.contents('A1') })).toBeVisible();
	const currentPart = publicMap.locator('.product-list [aria-current="page"]');
	await expect(currentPart).toContainText(seedProductCode(0));
	await expect(currentPart.locator('svg')).toHaveCount(0);
	await expect(publicMap.locator(`.product-list a[href='/en/p/${seedProductCode(0)}']`)).toHaveCount(0);
	const initialDrawerReads = drawerCatalogRequests.length;
	assert.ok(initialDrawerReads > 0, 'The current drawer loads on product-page entry');
	await showWall.tap();
	await expect(wall.getByRole('button')).toHaveCount(12);
	await expect(wall.locator('button[data-item-id][tabindex="0"]')).toHaveCount(1);
	await expect(wall.getByRole('button', { name: 'A1', exact: true })).toHaveAttribute('aria-current', 'true');
	await expect(publicMap.locator('.drawer-contents')).toHaveCount(0);
	await wall.getByRole('button', { name: 'A2', exact: true }).tap();
	const emptyCabinet = publicMap.getByRole('group', { name: mapMessages.cabinet('A2'), exact: true });
	await expect(emptyCabinet.getByRole('button')).toHaveCount(24);
	await emptyCabinet.getByRole('button', { name: `A1 · ${mapMessages.emptyDrawer}`, exact: true }).tap();
	await expect(publicMap.getByText(mapMessages.noProducts, { exact: true })).toBeVisible();
	assert.equal(drawerCatalogRequests.length, initialDrawerReads, 'Selecting a known empty drawer needs no catalog read');
	await showWall.tap();
	const wallA2 = wall.getByRole('button', { name: 'A2', exact: true });
	await expect(wallA2).toBeFocused();
	await mapPage.keyboard.press('ArrowDown');
	await expect(wall.getByRole('button', { name: 'A1', exact: true })).toBeFocused();
	await mapPage.keyboard.press('Enter');
	// Measure the settled cabinet, not a frame of its zoom animation.
	await publicMap.evaluate(async (element) => { await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
	const occupiedCabinet = publicMap.getByRole('group', { name: mapMessages.cabinet('A1'), exact: true });
	const firstDrawer = occupiedCabinet.getByRole('button', { name: 'A1', exact: true });
	await firstDrawer.focus(); await mapPage.keyboard.press('ArrowRight');
	const nextDrawer = occupiedCabinet.getByRole('button', { name: 'B1', exact: true });
	await expect(nextDrawer).toBeFocused();
	await mapPage.keyboard.press('Space');
	await expect(nextDrawer).toHaveAttribute('aria-pressed', 'true');
	await expect(firstDrawer).toHaveAttribute('aria-current', 'true');
	await expect(occupiedCabinet.locator('button[data-item-id][tabindex="0"]')).toHaveCount(1);
	await expect(publicMap.locator('.product-list')).toBeVisible();
	const contentsBefore = await publicMap.locator('.product-list').innerText();
	const selectedBefore = await nextDrawer.elementHandle();
	const drawerBefore = await documentBox(nextDrawer);
	await mapPage.getByLabel(fieldLabel(en.product.quantity)).fill('3');
	await nextDrawer.focus();
	let releaseRefresh!: () => void, refreshRequests = 0;
	const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
	await interactive.route(topologyUrl, async route => {
		refreshRequests++;
		const response = await route.fetch();
		await refreshGate;
		await route.fulfill({ response });
	});
	try {
		await mapPage.evaluate(() => {
			document.dispatchEvent(new Event('visibilitychange'));
			window.dispatchEvent(new Event('focus'));
			window.dispatchEvent(new Event('online'));
		});
		await expect.poll(() => refreshRequests).toBe(1);
		await expect(nextDrawer).toBeFocused();
		await expect(nextDrawer).toHaveAttribute('aria-pressed', 'true');
		assert.equal(await publicMap.locator('.product-list').innerText(), contentsBefore);
		assert.deepEqual(await documentBox(nextDrawer), drawerBefore);
		const refreshed = mapPage.waitForResponse(topologyUrl);
		releaseRefresh(); await refreshed;
		await expect(nextDrawer).toBeFocused();
		await expect(nextDrawer).toHaveAttribute('aria-pressed', 'true');
		assert.equal(await selectedBefore!.evaluate(element => element.isConnected), true, 'Automatic refresh retains the focused drawer node');
		await expect(mapPage.getByLabel(fieldLabel(en.product.quantity))).toHaveValue('3');
	} finally { releaseRefresh(); await interactive.unroute(topologyUrl); }
	await interactive.route(topologyUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
	await mapPage.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(publicMap.getByText(mapMessages.previousRead, { exact: true })).toBeVisible();
	await expect(nextDrawer).toBeFocused();
	await expect(nextDrawer).toHaveAttribute('aria-pressed', 'true');
	await interactive.unroute(topologyUrl);
	await publicMap.getByRole('button', { name: mapMessages.retry, exact: true }).click();
	await expect(publicMap.getByText(mapMessages.previousRead, { exact: true })).toHaveCount(0);
	await expect(publicMap.locator('button:not([data-item-id]):not([aria-expanded])')).toHaveCount(1);
	// A real placement change must reach the map/address without losing the
	// separately selected drawer or requiring a product reload.
	const selectedCabinet = `(SELECT cabinet_id FROM app.bins WHERE id='${seedBinId(0)}')`;
	await sql(`UPDATE app.cabinets SET outer_col=7 WHERE id=${selectedCabinet};`);
	try {
		await mapPage.evaluate(() => window.dispatchEvent(new Event('online')));
		const movedCabinet = publicMap.getByRole('group', { name: mapMessages.cabinet('G1'), exact: true });
		await expect(movedCabinet.getByRole('button', { name: 'B1', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(publicMap.locator('.loc').getByText('G1', { exact: true })).toBeVisible();
		await expect(publicMap.locator('.refresh-product')).toHaveCount(0);
	} finally { await sql(`UPDATE app.cabinets SET outer_col=1 WHERE id=${selectedCabinet};`); }
	await mapPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(occupiedCabinet).toBeVisible();
	await fits(mapPage);
	await publicMap.screenshot({ path: `${artifacts}/public-map-touch-keyboard-360.png` });
	await interactive.close();
	console.log('PASS: automatic map refresh preserves selection, contents, focus and quantity; overlapping lifecycle events share a read, and failure retains the map with contextual retry');

	const recoverable = await browser.newContext();
	const recoveryPage = await recoverable.newPage();
	recoveryPage.on('pageerror', error => errors.push(error.message));
	let unavailableOnce = true;
	await recoverable.route(topologyUrl, async route => {
		if (unavailableOnce) { unavailableOnce = false; await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
		else await route.continue();
	});
	await recoveryPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
	const recoveryMap = recoveryPage.locator('.shelf-map');
	await waitForHydration(recoveryPage);
	await recoveryPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(recoveryMap.getByText(mapMessages.previousRead, { exact: true })).toBeVisible();
	await expect(recoveryPage.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
	await recoveryPage.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(recoveryMap.locator('.stage [data-item-id][aria-current="true"]')).toHaveCount(1);
	await recoverable.close();

	const navigating = await browser.newContext();
	const navigationPage = await navigating.newPage();
	navigationPage.on('pageerror', error => errors.push(error.message));
	let releaseOld!: () => void, oldFinished!: () => void, held = false;
	const oldResponseGate = new Promise<void>(resolve => { releaseOld = resolve; });
	const oldSettled = new Promise<void>(resolve => { oldFinished = resolve; });
	await navigating.route(topologyUrl, async route => {
		if (held) { await route.continue(); return; }
		held = true;
		try {
			const response = await route.fetch();
			await oldResponseGate;
			await route.fulfill({ response }).catch(() => { /* The old product request was deliberately interrupted. */ });
		} finally { oldFinished(); }
	});
	// The first catalog page part in another drawer than the one being left.
	const catalog = await readCompleteCatalog({ url: api.origin, publishableKey: publicKey });
	const start = catalog.find(product => product.code === seedProductCode(0))!;
	const target = catalog.slice(0, 37).find(product => product.bin_code !== null && product.bin_code !== start.bin_code)!;
	assert.ok(target?.bin_code !== null && target.inner_col <= 26, 'The first catalog page has a part in another drawer');
	const targetDrawer = `${String.fromCharCode(64 + target.inner_col)}${target.inner_row}`;
	try {
		await navigationPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
		await waitForHydration(navigationPage);
		await navigationPage.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => held).toBe(true);
		await navigationPage.getByRole('link', { name: en.product.back }).click();
		await navigationPage.locator(`a[href='/en/p/${target.code}']`).click();
		await expect(navigationPage).toHaveURL(`${origin}/en/p/${target.code}`);
		const current = navigationPage.locator('.shelf-map .stage [data-item-id][aria-current="true"]');
		await expect(current).toHaveAttribute('aria-label', targetDrawer);
		releaseOld(); await oldSettled;
		await expect(current).toHaveAttribute('aria-label', targetDrawer);
	} catch (error) { await captureFailure(navigationPage, artifacts, 'navigation'); throw error; }
	finally { releaseOld(); await navigating.close(); }
	console.log('PASS: failed topology retries independently of purchase controls; interrupted product navigation retains the new product location');

	for (const locale of ['', '/en']) for (const colour of ['light', 'dark'] as const) for (const width of [320, 360, 768, 1024, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: colour });
		for (const route of ['/p', `/p/${seedProductCode(0)}`, '/cart']) {
			if ((width === 320 || width === 1024) && !route.startsWith('/p/')) continue;
			await page.goto(origin + locale + route);
			await expect(page.locator('h1')).toBeVisible();
			if (route === '/p') {
				await expect(page.locator('.search-submit')).toBeEnabled({ timeout: 30000 });
				const filters = page.getByRole('button', { name: locale ? 'Filters' : 'Filtre', exact: true });
				await expect(filters).toHaveAttribute('aria-controls', 'catalog-filters');
				await expect(filters).toHaveAttribute('aria-haspopup', 'dialog');
				const dialog = page.getByRole('dialog', { name: locale ? 'Filter parts' : 'Filtrer deler', exact: true });
				await expect(dialog).toBeHidden();
				const triggerBox = await filters.boundingBox();
				const searchBox = await page.locator('#catalog-search').boundingBox();
				const buttonStyle = await filters.evaluate((element) => {
					const style = getComputedStyle(element);
					return { border: style.borderTopWidth, colour: style.borderTopColor };
				});
				assert.notEqual(buttonStyle.border, '0px', 'Filters has a visible button border');
				assert.notEqual(buttonStyle.colour, 'rgba(0, 0, 0, 0)');
				await filters.press('Enter');
				await expect(dialog).toBeVisible();
				assert.deepEqual(await page.locator('.filter-toggle').boundingBox(), triggerBox, 'Opening filters keeps its button in place');
				assert.deepEqual(await page.locator('#catalog-search').boundingBox(), searchBox, 'Opening filters keeps search in place');
				await fits(page);
				// Measure the settled dialog, not a frame of its opening animation.
				await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
				const applyBox = await dialog.getByRole('button', { name: locale ? 'Show results' : 'Vis resultater', exact: true }).boundingBox();
				const viewportHeight = page.viewportSize()!.height;
				assert.ok(applyBox && applyBox.y >= 0 && applyBox.y + applyBox.height <= viewportHeight, 'Filter actions stay in the viewport outside the scrolling options');
				await dialog.getByRole('button', { name: locale ? 'Close filters' : 'Lukk filtre', exact: true }).press('Enter');
				await expect(dialog).toBeHidden();
				await expect(filters).toBeFocused();
				if (width === 360 || width === 1280) {
					const messages = locale ? en : nb;
					const locations = page.getByRole('button', { name: messages.catalog.location, exact: true });
					await expect(locations).toHaveAttribute('aria-controls', 'catalog-locations');
					const locationsBox = await locations.boundingBox();
					await locations.press('Enter');
					const locationDialog = page.getByRole('dialog', { name: messages.catalog.location, exact: true });
					await expect(locationDialog).toBeVisible();
					assert.deepEqual(await locations.boundingBox(), locationsBox, 'Opening location keeps its button in place');
					await locationDialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
					const close = locationDialog.getByRole('button', { name: messages.catalog.closeLocations, exact: true });
					assert.ok(((await close.boundingBox())?.y ?? -1) >= 0, 'The location dialog header stays in the viewport');
					// Phones get a bottom sheet anchored at the thumb; wider screens a fixed side panel.
					const settled = () => locationDialog.evaluate(async (element) => { await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))); });
					const anchor = async () => {
						await settled();
						const box = width < 768 ? await locationDialog.evaluate(element => ({ y: element.getBoundingClientRect().bottom })) : await close.boundingBox();
						return box && Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value)]));
					};
					const anchorBefore = await anchor();
					if (width < 768) assert.equal(anchorBefore?.y, viewportHeight, 'The phone shelf map is a bottom sheet');
					const selection = locationDialog.locator('.label-shelf-selection');
					const cabinet = selection.getByRole('button', { name: messages.adminLabels.cabinet('A1'), exact: true });
					await expect(cabinet).toBeEnabled();
					assert.ok(await selection.locator('.wall-viewport').evaluate(element => element.scrollWidth <= element.clientWidth),
						'The installed wall fits the shelf map sheet without sideways scrolling');
					await cabinet.press('Enter');
					await expect(selection.locator(`[data-item-id='${seedBinId(0)}']`)).toBeVisible();
					await settled();
					assert.ok(await locationDialog.getByRole('region', { name: messages.catalog.location, exact: true }).evaluate(element => element.scrollHeight <= element.clientHeight), 'A whole cabinet fits without scrolling');
					assert.deepEqual(await anchor(), anchorBefore, 'Zooming into a cabinet keeps the sheet anchored');
					await fits(page);
					await selection.getByRole('button', { name: messages.shelfMap.showWall, exact: true }).press('Enter');
					assert.deepEqual(await anchor(), anchorBefore, 'Returning to the wall keeps the sheet anchored');
					await fits(page);
					await locationDialog.getByRole('button', { name: messages.catalog.closeLocations, exact: true }).press('Enter');
					await expect(locationDialog).toBeHidden();
					await expect(locations).toBeFocused();
				}
			}
			if (route.startsWith('/p/')) {
				const messages = locale ? en : nb;
				if (width < 768) {
					await expect(page.locator('#map-title button')).toHaveAttribute('aria-expanded', 'false');
					await expect(page.locator('.shelf-map > .loc')).toBeVisible();
					await expect(page.locator('.shelf-map > .loc')).toContainText(messages.shop.drawer);
				}
				await openShelfMap(page);
				const shelf = page.locator('.shelf-map');
				await expect(shelf.getByRole('group', { name: messages.shelfMap.cabinet('A1'), exact: true })).toBeVisible();
				await expect(shelf.locator('.coordinate-list, .levels button[aria-expanded]')).toHaveCount(0);
				const hitboxes = await shelf.locator('.cell-hit').evaluateAll(elements => elements.map(element => {
					const box = element.getBoundingClientRect(); return { width: box.width, height: box.height };
				}));
				assert.equal(hitboxes.length, 48, 'The zoomed-in current cabinet shows its forty-eight drawers as direct targets');
				for (const box of hitboxes) {
					assert.ok(box.width >= 24 && box.height >= 24, `Map hit target is at least 24px at ${width}px: ${JSON.stringify(box)}`);
				}
				for (const control of [page.getByLabel(fieldLabel(messages.product.quantity)), page.getByRole('button', { name: messages.product.add, exact: true })]) {
					const box = await control.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44, 'Ordinary purchase controls keep 44px targets');
				}
				const stepper = page.getByLabel(fieldLabel(messages.product.quantity)).locator('..');
				const stepperBox = await stepper.boundingBox();
				assert.ok(stepperBox);
				for (const button of await stepper.getByRole('button').all()) {
					const box = await button.boundingBox();
					assert.ok(box && box.width >= 44 && box.height >= 44, 'Quantity actions keep 44px targets');
					assert.ok(box.x >= stepperBox.x && box.x + box.width <= stepperBox.x + stepperBox.width + 1
						&& box.y >= stepperBox.y && box.y + box.height <= stepperBox.y + stepperBox.height + 1,
						'Joined quantity buttons fit inside their control boundary');
				}
				const summary = await page.locator('.product-summary').boundingBox();
				const location = await page.locator('.product-location').boundingBox();
				assert.ok(summary && location);
				if (width >= 768) {
					assert.ok(location.x >= summary.x + summary.width, 'Product information and visible map share two columns');
					expect(location.y).toBeCloseTo(summary.y, 1);
				} else assert.ok(location.y >= summary.y + summary.height, 'Phone product information precedes its visible map');
			}
			if (route === '/cart') await expect(page.locator('input[inputmode=decimal]').first()).toBeEnabled();
			await fits(page);
			if (width === 360 || width === 1280) await page.screenshot({ path: `${artifacts}/${locale ? 'en' : 'nb'}-${colour}-${width}-${route === '/p' ? 'catalog' : route === '/cart' ? 'cart' : 'product'}.png`, fullPage: true });
		}
	}
	console.log('PASS: catalog/cart at360/768/1280 and compactproduct at320/360/768/1024/1280 in both languages/themes; map targets24px+, purchase targets44px+, and long-name geometry');

	await page.goto(`${origin}/en/cart`);
	await expect(page.locator('.cart-line').last().getByRole('button', { name: /^Remove / })).toBeEnabled();
	await page.locator('.cart-line').last().getByRole('button', { name: /^Remove / }).press('Enter');
	await expect(page.locator('.cart-line')).toHaveCount(1);
	await expect(page.locator('.cart-line .remove')).toBeFocused();
	await expect(page.locator('.header-cart [data-slot=badge]')).toHaveText('1');
	assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity), '11');
	await page.locator('.cart-line .remove').press('Enter');
	await expect(page.locator('#cart-browse')).toBeFocused();
	console.log('PASS: automatic quantity save and line removal update persisted basket and header');
	await page.evaluate(() => localStorage.setItem('ampoteket:cart', '{broken'));
	await page.reload();
	await expect(page.getByText(en.cart.invalid, { exact: true })).toBeVisible();
	assert.equal(await page.evaluate(() => localStorage.getItem('ampoteket:cart')), '{broken');
	await page.evaluate(() => localStorage.removeItem('ampoteket:cart'));
	await page.reload();

	// A durable active pointer locks every mutation, even if another tab owns it.
	await page.evaluate(async () => {
		await navigator.locks.request('ampoteket:cart-and-checkout:v1', async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ampoteket:checkout', 1);
				request.onsuccess = () => resolve(request.result); request.onerror = reject;
			});
			await new Promise<void>((resolve, reject) => {
				const tx = database.transaction('attempts', 'readwrite');
				tx.objectStore('attempts').put({ requestId: crypto.randomUUID(), fingerprint: 'a'.repeat(64), version: 1, createdAt: new Date().toISOString(), state: 'preparing' }, 'active');
				tx.oncomplete = () => resolve(); tx.onabort = reject;
			});
			database.close();
		});
	});
	await page.goto(`${origin}/en/p/${seedProductCode(0)}`);
	await expect(page.getByText(en.cart.locked, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled();
	assert.equal(await page.evaluate(() => localStorage.getItem('ampoteket:cart')), null);
	console.log('PASS: malformed cart is retained; active checkout blocks new basket mutations');

	const noJs = await context.browser()!.newContext({ javaScriptEnabled: false });
	const plain = await noJs.newPage();
	for (const locale of ['', '/en']) {
		const messages = locale ? en : nb;
		await plain.goto(origin + (locale || '/'));
		await expect(plain.getByText(messages.shelfMap.noJavascript, { exact: true })).toBeVisible();
		await expect(plain.getByRole('button', { name: messages.home.find.shelfOpen, exact: true })).toHaveCount(0);
		await expect(plain.getByRole('button', { name: messages.scanner.open, exact: true })).toBeHidden();
		await plain.locator(`header a[href="${locale}/p"]:visible`).click();
		await expect(plain).toHaveURL(`${origin}${locale}/p`);
		await expect(plain.locator('.cards > li').first()).toBeVisible();
		await plain.goto(origin + (locale || '/'));
		await plain.getByLabel(fieldLabel(messages.home.find.codeLabel)).fill(seedProductCode(999));
		await plain.getByRole('button', { name: messages.home.find.codeSubmit, exact: true }).click();
		await expect(plain).toHaveURL(`${origin}${locale}/p/${seedProductCode(999)}`);
	}
	await plain.goto(`${origin}/en/p?cabinet=${catalogCabinetId}`);
	// Category shortcuts are plain links: select one alone, tap again to remove it.
	const shortcut = plain.getByRole('navigation', { name: en.catalog.category }).getByRole('link', { name: 'Capacitor', exact: true });
	await shortcut.click();
	await expect(plain).toHaveURL(`${origin}/en/p?cabinet=${catalogCabinetId}&category=Capacitors`);
	await expect(shortcut).toHaveAttribute('aria-current', 'true');
	await shortcut.click();
	await expect(plain).toHaveURL(`${origin}/en/p?cabinet=${catalogCabinetId}`);
	await expect(shortcut).not.toHaveAttribute('aria-current', 'true');
	await expect(plain.locator(`a[href='/en/p/${expectedCodes[0]}']`)).toBeVisible();
	await plain.getByRole('link', { name: en.catalog.next, exact: true }).click();
	assert.ok(new URL(plain.url()).searchParams.has('after'));
	assert.equal(new URL(plain.url()).searchParams.get('cabinet'), catalogCabinetId);
	await expect(plain.locator('ul[aria-label=Parts] li').first()).toBeVisible();
	await plain.goto(`${origin}/en/p?category=Capacitors&eq.capacitance=0.000000000005&bin=${seedBinId(5)}`);
	await expect(plain.locator(`a[href='/en/p/${seedProductCode(5)}']`)).toBeVisible();
	await expect(plain.locator(`a[href='/en/p/${seedProductCode(6)}']`)).toHaveCount(0);
	await plain.getByLabel(fieldLabel(en.catalog.searchLabel)).fill('capacitor');
	await plain.getByRole('button', { name: en.catalog.search, exact: true }).click();
	await expect(plain).toHaveURL(url => url.searchParams.get('q') === 'capacitor'
		&& url.searchParams.getAll('category').join(',') === 'Capacitors'
		&& url.searchParams.get('eq.capacitance') === '0.000000000005' && url.searchParams.get('bin') === seedBinId(5));
	await expect(plain.locator(`a[href='/en/p/${seedProductCode(5)}']`)).toBeVisible();
	await expect(plain.locator(`a[href='/en/p/${seedProductCode(6)}']`)).toHaveCount(0);
	await plain.locator('header a[hreflang=nb]').click();
	await expect(plain).toHaveURL(url => url.pathname === '/p' && url.searchParams.get('bin') === seedBinId(5)
		&& url.searchParams.get('category') === 'Capacitors' && url.searchParams.get('q') === 'capacitor');
	await plain.goto(`${origin}/en/p?code=${seedProductCode(999)}`);
	await expect(plain.locator('h1')).toBeVisible();
	await expect(plain).toHaveURL(`${origin}/en/p/${seedProductCode(999)}`);
	await noJs.close();
	const failedFacets = await context.browser()!.newContext();
	await failedFacets.route(`${api.origin}/rest/v1/rpc/amp_catalog_facets`, route =>
		route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
	const facetPage = await failedFacets.newPage();
	await facetPage.goto(`${origin}/en/p?category=Capacitors&eq.capacitance=0.000000000005`);
	await expect(facetPage.locator(`a[href='/en/p/${seedProductCode(5)}']`)).toBeVisible();
	await facetPage.locator('.filter-toggle').click();
	const failedDialog = facetPage.getByRole('dialog', { name: en.catalog.filterTitle, exact: true });
	await expect(failedDialog.getByText(en.catalog.filtersUnavailable, { exact: true })).toBeVisible();
	await failedDialog.getByRole('button', { name: en.catalog.cancel, exact: true }).click();
	await expect(facetPage.locator('.search-submit')).toBeEnabled();
	await facetPage.getByLabel(fieldLabel(en.catalog.searchLabel)).fill('capacitor');
	await facetPage.getByRole('button', { name: en.catalog.search, exact: true }).click();
	await expect(facetPage).toHaveURL(url => url.searchParams.get('q') === 'capacitor'
		&& url.searchParams.getAll('category').join(',') === 'Capacitors'
		&& url.searchParams.get('eq.capacitance') === '0.000000000005');
	await expect(facetPage.locator(`a[href='/en/p/${seedProductCode(5)}']`)).toBeVisible();
	await expect(facetPage.locator(`a[href='/en/p/${seedProductCode(6)}']`)).toHaveCount(0);
	await failedFacets.close();
	console.log('PASS: main search retains typed category/specification filters and server results without JavaScript or available facet metadata');
	const manual = await context.browser()!.newContext();
	await manual.addInitScript(() => { Object.defineProperty(window, 'IntersectionObserver', { value: undefined, configurable: true }); });
	const manualPage = await manual.newPage();
	await manualPage.goto(`${origin}/en/p`);
	await expect(manualPage.locator('.search-submit')).toBeEnabled({ timeout: 30000 });
	await expect(manualPage.locator('.cards > li')).toHaveCount(37);
	const showMore = manualPage.getByRole('link', { name: 'Show more', exact: true });
	await showMore.focus();
	const manualScroll = await manualPage.evaluate(() => window.scrollY);
	await showMore.press('Enter');
	await expect(manualPage.locator('.cards > li')).toHaveCount(74);
	await expect(manualPage).toHaveURL(`${origin}/en/p`);
	assert.equal(await manualPage.evaluate(() => window.scrollY), manualScroll, 'Keyboard append preserves scroll');
	assert.deepEqual(await manualPage.locator('.cards .product-meta .font-mono').allTextContents(), expectedCodes.slice(0, 74));
	await expect(showMore).toBeFocused();
	await manual.close();
	console.log('PASS: keyboard Show more appends ordered parts when IntersectionObserver is unavailable');
	const failing = await context.browser()!.newContext();
	await failing.route(`${api.origin}/rest/v1/rpc/amp_catalog`, async (route) => {
		const body = route.request().postDataJSON();
		if (body.p_after_code) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
		else await route.continue();
	});
	const failedPage = await failing.newPage();
	await failedPage.goto(`${origin}/en/p`);
	await expect(failedPage.locator('.search-submit')).toBeEnabled();
	await failedPage.locator('.pagination').scrollIntoViewIfNeeded();
	await expect(failedPage.getByRole('button', { name: 'Try again', exact: true })).toBeVisible({ timeout: 30000 });
	await expect(failedPage.locator('.search-submit')).toBeEnabled();
	await expect(failedPage.locator('ul[aria-label=Parts] li').first()).toBeVisible();
	await expect(failedPage.getByText('No parts match', { exact: false })).toHaveCount(0);
	await expect(failedPage.locator('.cards > li')).toHaveCount(37);
	await failing.unroute(`${api.origin}/rest/v1/rpc/amp_catalog`);
	await failedPage.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(failedPage.locator('.cards > li')).toHaveCount(74);
	await failing.close();
	const denied = await context.browser()!.newContext();
	await denied.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Disabled for test', 'SecurityError'); }; });
	const deniedPage = await denied.newPage();
	await deniedPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
	await expect(deniedPage.getByText(en.cart.storage, { exact: true })).toBeVisible();
	await expect(deniedPage.getByRole('button', { name: 'Add to cart', exact: true })).toBeDisabled();
	await denied.close();
	const silent = await context.browser()!.newContext();
	await silent.addInitScript(() => {
		Object.defineProperty(globalThis, 'BroadcastChannel', {
			value: class { constructor() { throw new DOMException('Disabled for test', 'SecurityError'); } }
		});
	});
	const silentPage = await silent.newPage();
	await silentPage.goto(`${origin}/en/p/${seedProductCode(0)}`);
	await expect(silentPage.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
	await silentPage.getByRole('button', { name: 'Add to cart', exact: true }).click();
	await expect(silentPage.locator('#quantity-result')).toHaveText('Added to the cart.');
	await expect(silentPage.locator('.header-cart [data-slot=badge]')).toHaveText('1');
	assert.equal(await silentPage.evaluate(() => JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]')[0]?.quantity), '1');
	await silent.close();
	// Real price/sale-step changes revalidate on return without replacing drafts.
	const freshContext = await context.browser()!.newContext();
	const freshPage = await freshContext.newPage();
	const changedId = seedProductId(0), changedCode = seedProductCode(0);
	const previous = JSON.parse(await sql(`SELECT json_build_object('step',sale_step::text,'price',sale_unit_price_nok::text) FROM app.products WHERE id='${changedId}'`)) as { step: string; price: string };
	try {
		await freshPage.goto(`${origin}/en/p/${changedCode}`);
		const input = freshPage.getByLabel(fieldLabel(en.product.quantity));
		const add = freshPage.getByRole('button', { name: en.product.add, exact: true });
		await expect(add).toBeEnabled();
		await input.fill('3');
		await sql(`UPDATE app.products SET sale_step=2,sale_unit_price_nok=13.37 WHERE id='${changedId}'`);
		let releaseProduct!: () => void, productRefreshes = 0;
		const productGate = new Promise<void>(resolve => { releaseProduct = resolve; });
		await freshPage.route(drawerCatalogUrl, async route => {
			if (route.request().postDataJSON().p_code === changedCode && ++productRefreshes === 1) await productGate;
			await route.continue();
		});
		await freshPage.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect.poll(() => productRefreshes).toBe(1);
		await freshPage.evaluate(() => window.dispatchEvent(new Event('online')));
		releaseProduct();
		await expect.poll(() => productRefreshes).toBe(2);
		await expect(freshPage.locator('.product-summary')).toContainText('13.37 NOK');
		await expect(add).toBeEnabled();
		await expect(input).toHaveValue('3'); await expect(input).toBeFocused();
		await freshPage.unroute(drawerCatalogUrl);
		await freshPage.route(drawerCatalogUrl, async route => {
			if (route.request().postDataJSON().p_code === changedCode) await route.abort('failed');
			else await route.continue();
		});
		await freshPage.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect(freshPage.locator('.product-summary').getByText(en.product.unavailable, { exact: true })).toBeVisible();
		await expect(add).toBeDisabled(); await expect(input).toHaveValue('3');
		await expect(freshPage.locator('.product-summary')).toContainText('13.37 NOK');
		await freshPage.unroute(drawerCatalogUrl);
		await freshPage.locator('.product-summary').getByRole('button', { name: en.product.retry, exact: true }).click();
		await expect(add).toBeEnabled();
		await freshPage.evaluate(({ product_id, code }) => localStorage.setItem('ampoteket:cart', JSON.stringify([{ product_id, code, quantity: '1' }])), { product_id: changedId, code: changedCode });
		await freshPage.goto(`${origin}/en/cart`);
		const quantityInput = freshPage.locator('input[inputmode=decimal]').first();
		await expect(quantityInput).toHaveAttribute('aria-invalid', 'true');
		await expect(freshPage.locator('.cart-line')).toContainText(en.cart.step('2', 'pieces'));
		await expect(freshPage.getByRole('button', { name: en.checkout.proceed, exact: true })).toBeDisabled();
		await quantityInput.fill('');
		await sql(`UPDATE app.products SET sale_step=1,sale_unit_price_nok=22 WHERE id='${changedId}'`);
		let releaseCart!: () => void, cartRefreshes = 0;
		const cartGate = new Promise<void>(resolve => { releaseCart = resolve; });
		await freshPage.route(drawerCatalogUrl, async route => {
			if (++cartRefreshes === 1) await cartGate;
			await route.continue();
		});
		await freshPage.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect.poll(() => cartRefreshes).toBe(1);
		await freshPage.evaluate(() => window.dispatchEvent(new Event('online')));
		releaseCart();
		await expect.poll(() => cartRefreshes).toBe(2);
		await expect(freshPage.locator('.cart-line')).toContainText('22.00 NOK');
		await expect(quantityInput).toHaveValue(''); await expect(quantityInput).toBeFocused();
		await freshPage.unroute(drawerCatalogUrl);
		await quantityInput.fill('2');
		await expect(freshPage.getByRole('button', { name: en.checkout.proceed, exact: true })).toBeEnabled();
		await freshPage.route(drawerCatalogUrl, route => route.abort('failed'));
		await freshPage.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect(freshPage.getByText(en.cart.factsUnavailable, { exact: true })).toBeVisible();
		await expect(freshPage.locator('.cart-line h2')).toContainText('220');
		await expect(quantityInput).toHaveValue('2'); await expect(quantityInput).toBeFocused();
		await expect(freshPage.getByRole('button', { name: en.checkout.proceed, exact: true })).toBeDisabled();
	} finally {
		await sql(`UPDATE app.products SET sale_step='${previous.step}',sale_unit_price_nok='${previous.price}' WHERE id='${changedId}'`);
		await freshContext.close();
	}
	console.log('PASS: product/cart refresh retains focused drafts and old facts on failure; changed sale steps get visible line errors; removal preserves keyboard focus; mobile placement stays visible');
	// Valid long metadata and sparse wide topology must remain usable inside the
	// phone filter and location dialogs, where the page container cannot supply text wrapping.
	const longCategory = 'W'.repeat(100);
	await sql(`UPDATE app.categories SET name='${longCategory}' WHERE name='Resistors'; UPDATE app.cabinets SET outer_col=16 WHERE id='${catalogCabinetId}';`);
	try {
		await page.setViewportSize({ width: 360, height: 640 });
		await page.goto(`${origin}/en/p`);
		await page.getByRole('button', { name: en.catalog.filters, exact: true }).click();
		const filters = page.getByRole('dialog', { name: en.catalog.filterTitle, exact: true });
		const category = filters.getByRole('checkbox', { name: longCategory, exact: true });
		await expect(category).toBeEnabled();
		const label = category.locator('xpath=ancestor::label[1]');
		await label.scrollIntoViewIfNeeded();
		await expect(label).toBeInViewport({ ratio: 1 });
		assert.ok(await label.evaluate(element => element.scrollWidth <= element.clientWidth), 'A 100-character category fits its label');
		assert.ok(await filters.locator('.filter-dialog-body').evaluate(element => element.scrollWidth <= element.clientWidth), 'Long metadata does not cause sideways filter scrolling');
		await filters.getByRole('button', { name: en.catalog.closeFilters, exact: true }).click();
		await page.getByRole('button', { name: en.catalog.location, exact: true }).click();
		const locations = page.getByRole('dialog', { name: en.catalog.location, exact: true });
		const selection = locations.locator('.label-shelf-selection');
		const wall = selection.getByRole('group', { name: en.adminLabels.wall, exact: true });
		const wallViewport = selection.getByRole('region', { name: en.adminLabels.wall, exact: true });
		await wallViewport.scrollIntoViewIfNeeded();
		await expect(wallViewport).toHaveAttribute('tabindex', '0');
		await expect(wallViewport).toHaveCSS('overscroll-behavior', 'contain');
		for (const box of await wall.getByRole('button').evaluateAll(elements => elements.map(element => { const { width, height } = element.getBoundingClientRect(); return { width, height }; }))) {
			assert.ok(box.width >= 24 && box.height >= 24, 'Dense label walls preserve cabinet touch targets');
		}
		assert.ok(await wallViewport.evaluate(element => element.scrollWidth > element.clientWidth), 'A 16-column wall pans inside its named viewport');
		const lastCabinet = wall.getByRole('button', { name: en.adminLabels.cabinet('P1'), exact: true });
		await lastCabinet.focus();
		await expect.poll(() => wallViewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		await expect(lastCabinet).toBeInViewport({ ratio: 1 });
		await fits(page);
		await locations.getByRole('button', { name: en.catalog.closeLocations, exact: true }).click();
	} finally {
		await sql(`UPDATE app.categories SET name='Resistors' WHERE name='${longCategory}'; UPDATE app.cabinets SET outer_col=1 WHERE id='${catalogCabinetId}';`);
	}
	console.log('PASS: long category text wraps and a dense label wall retains 24px targets with local keyboard panning');
	assert.deepEqual(errors, []);
	console.log('PASS: no-JavaScript SSR paging/lookup, unavailable reads, denied storage, optional notifications and keyboard submission');
	console.log(`PASS: catalog/product/cart acceptance; screenshots: ${artifacts}`);
} catch (error) {
	for (const [index, page] of (context?.browser()?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
		await captureFailure(page, artifacts, String(index));
	}
	const raw = await Bun.file(`${directory}/worker-error.log`).text() + await Bun.file(`${directory}/worker.log`).text();
	const redacted = safe(raw);
	if (redacted.trim()) console.error(redacted.slice(-3000));
	throw error;
} finally { await close(); }
