/**
 * Actual production scanner, local Supabase and the real QR WASM decoder.
 * Only camera hardware is substituted: generated label pixels enter through
 * canvas.captureStream(). This proves application behavior, never phone cameras.
 */
import { firefox, webkit, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fieldLabel, proofEnvironment } from './web-proof/harness';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { generateSeedSql, seedProductId, seedProductCode } from './seed-test-data';
import { en } from '../src/lib/i18n/en';

const { directory, origin, api, ca, sql, startWorker } = await proofEnvironment();
await sql("SET ampoteket.test_seed = 'disposable-only';\n" + generateSeedSql());
await sql(`UPDATE app.products SET name_nb='220 ohm motstand med et langt produktnavn for smale skjermer', name_en='220 ohm resistor with a long product name to exercise narrow screen wrapping' WHERE id='${seedProductId(0)}';`);

// Use the pinned writer's local WASM, including the quiet zone. No QR-generation
// service or external network is involved, and production only ships the reader.
prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(await Bun.file('node_modules/zxing-wasm/dist/writer/zxing_writer.wasm').arrayBuffer()) } });
const labels: Record<string, string> = {};
const payloads = {
	first: `ampoteket.no/p/${seedProductCode(0)}`,
	second: `ampoteket.no/p/${seedProductCode(1)}`,
	free: `https://ampoteket.no/p/${seedProductCode(27)}`,
	unknown: 'https://ampoteket.no/p/UNKNOWN-QR',
	foreign: 'https://example.org/p/RES-00001',
	malformed: 'https://ampoteket.no/p/RES-00001?code=RES-00002',
	plain: seedProductCode(0)
};
for (const [name, payload] of Object.entries(payloads)) {
	const written = await writeBarcode(payload, { format: 'QRCode', options: 'ecLevel=M', addQuietZones: true, scale: 8 });
	assert.equal(written.error, '', 'QR fixture generation succeeds');
	labels[name] = `data:image/svg+xml;base64,${Buffer.from(written.svg).toString('base64')}`;
}
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context);
const browserDiagnostics: string[] = [];
const artifacts = resolve('test-results/scanner');
await mkdir(artifacts, { recursive: true });
for (const [name, uri] of Object.entries(labels)) await writeFile(`${artifacts}/qr-${name}.svg`, Buffer.from(uri.split(',')[1], 'base64'));
await writeFile(`${artifacts}/synthetic-labels.html`, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synthetic scanner acceptance fixtures</title>
<style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:1rem}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:2rem}article{break-inside:avoid}img{display:block;width:40mm;height:40mm}code{overflow-wrap:anywhere}@media print{body{margin:0;font-size:10pt}main{grid-template-columns:repeat(2,1fr)}}</style>
<h1>Synthetic scanner acceptance fixtures</h1>
<p>For the disposable seeded test shop only. First, second and free match the standard synthetic seed; unknown is deliberately absent. Foreign, malformed and plain must be rejected by camera scanning. A plain code remains valid manual entry.</p>
<p>Quiet zones are part of each SVG and must remain intact. The illustrative 40 mm specimens are not accepted warehouse-label dimensions or the production A4 label feature. Final phone acceptance still needs the actual label stock, measured size, mounting, lighting and scan distance. Use the app's scanner; these codes do not contain live workshop records.</p>
<main>${Object.entries(payloads).map(([name, payload]) => `<article><h2>${name}</h2><img src="qr-${name}.svg" alt="QR fixture: ${name}"><code>${payload}</code></article>`).join('\n')}</main></html>`);

type Scene = { label: string; x: number; y: number; size: number }[];
type CameraStats = { requests: number; live: number; stopped: number; draws: number; paints: number; delayed: number; constraints: MediaStreamConstraints[] };
type CameraProof = {
	mediaDevices: MediaDevices;
	scene: (scene: Scene) => Promise<void>;
	stats: () => CameraStats;
	mode: (mode: 'live' | 'deny' | 'delay') => void;
	release: () => void;
	end: () => void;
	hidden: (hidden: boolean) => void;
	denyBasket: (deny: boolean) => void;
};
declare global { interface Window { cameraProof: CameraProof } }
async function installCamera(browserContext: BrowserContext) {
	await browserContext.addInitScript(({ labels }) => {
		// Keep the patched host wrapper reachable. Desktop WebKit can otherwise
		// collect it during module loading and expose a fresh native getUserMedia.
		const mediaDevices = navigator.mediaDevices;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 900;
		const ctx = canvas.getContext('2d')!;
		let mode: 'live' | 'deny' | 'delay' = 'live';
		let pictures: { image: HTMLImageElement; x: number; y: number; size: number }[] = [];
		let requests = 0, draws = 0, paints = 0, stopped = 0;
		const constraints: MediaStreamConstraints[] = [];
		const tracks: MediaStreamTrack[] = [];
		const pending: (() => void)[] = [];
		const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
		CanvasRenderingContext2D.prototype.drawImage = function(...args: [CanvasImageSource, ...number[]]) {
			if (args[0] instanceof HTMLVideoElement) draws++;
			return Reflect.apply(originalDraw, this, args);
		};
		function paint() {
			ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 900, 900);
			ctx.imageSmoothingEnabled = false;
			for (const picture of pictures) ctx.drawImage(picture.image, picture.x, picture.y, picture.size, picture.size);
			paints++;
		}
		paint(); setInterval(paint, 50);
		Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: async (requested: MediaStreamConstraints) => {
			requests++; constraints.push(requested);
			if (mode === 'deny') throw new DOMException('Synthetic permission rejection', 'NotAllowedError');
			if (mode === 'delay') await new Promise<void>((resolve) => pending.push(resolve));
			const stream = canvas.captureStream(20);
			for (const track of stream.getTracks()) {
				tracks.push(track);
				const stop = track.stop.bind(track);
				track.stop = () => { if (track.readyState === 'live') stopped++; stop(); };
			}
			paint();
			return stream;
		} });
		const originalSetItem = Storage.prototype.setItem;
		let denyBasket = false;
		Storage.prototype.setItem = function(key, value) {
			if (denyBasket && this === localStorage && key === 'ampoteket:cart') throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
			return originalSetItem.call(this, key, value);
		};
		window.cameraProof = {
			mediaDevices,
			async scene(scene) {
				pictures = await Promise.all(scene.map(async (item) => {
					const image = new Image(); image.src = labels[item.label]; await image.decode();
					return { ...item, image };
				}));
				paint();
			},
			stats: () => ({ requests, draws, paints, stopped, live: tracks.filter((track) => track.readyState === 'live').length, delayed: pending.length, constraints }),
			mode: (next) => { mode = next; },
			release: () => { for (const resume of pending.splice(0)) resume(); },
			end: () => { for (const track of tracks) if (track.readyState === 'live') { track.stop(); track.dispatchEvent(new Event('ended')); } },
			hidden: (hidden) => {
				Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
				Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
				document.dispatchEvent(new Event('visibilitychange'));
			},
			denyBasket: (deny) => { denyBasket = deny; }
		};
	}, { labels });
}
const scanner = (page: Page) => page.locator('.scanner');
const scannerDialog = (page: Page) => page.getByRole('dialog');
const action = (page: Page, name: string) => page.locator('.scanner, .scanner-dialog').getByRole('button', { name, exact: true });
async function state(page: Page, value: string) { await expect(scanner(page)).toHaveAttribute('data-state', value, { timeout: 20000 }); }
async function camera(page: Page, value: string) { await expect(scanner(page)).toHaveAttribute('data-camera', value, { timeout: 20000 }); }
async function stats(page: Page) { return page.evaluate(() => window.cameraProof.stats()); }
async function paint(page: Page, label: string | null) {
	const before = await page.evaluate(async (label) => {
		await window.cameraProof.scene(label ? [{ label, x: 250, y: 250, size: 400 }] : []);
		const video = document.querySelector<HTMLVideoElement>('video.scanner-video');
		return video && !video.paused && video.readyState >= 2 ? video.currentTime : null;
	}, label);
	// captureStream delivery is asynchronous. Present multiple frames of the new
	// scene before an Add/Cancel action tests which label is still in the camera.
	if (before !== null) await expect.poll(() => page.evaluate(() => document.querySelector<HTMLVideoElement>('video.scanner-video')?.currentTime ?? 0)).toBeGreaterThan(before + 0.15);
}
async function decodedFrames(page: Page, count: number) {
	const before = (await stats(page)).draws;
	await expect.poll(async () => (await stats(page)).draws, { timeout: 10000 }).toBeGreaterThanOrEqual(before + count);
}
// Phones float the scanner trigger; above 40rem it is a row in the header menu.
async function trigger(page: Page, name = 'Scan QR code') {
	// Phones (≤ 40rem, the `phone:` variant) float the trigger; wider screens list it in the menu.
	if ((page.viewportSize()?.width ?? 1280) <= 640) {
		await expect(action(page, name)).toBeVisible({ timeout: 30000 });
		return action(page, name);
	}
	// The scanner's own trigger stays disabled until it mounts: the page is interactive then.
	await expect(page.locator('.scanner-trigger')).toBeEnabled({ timeout: 30000 });
	if (await page.locator('.menu-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.menu-toggle').click();
	const row = page.locator('#site-menu').getByRole('button', { name, exact: true });
	await expect(row).toBeVisible();
	return row;
}
async function open(page: Page) {
	await (await trigger(page)).click();
	await camera(page, 'scanning');
	await scannerDialog(page).evaluate(async (dialog) => { await Promise.all(dialog.getAnimations().map((animation) => animation.finished)); });
}
async function rearm(page: Page) {
	await paint(page, null);
	await decodedFrames(page, 8);
}
async function quantity(page: Page, index = 0): Promise<string | null> {
	return page.evaluate((id) => (JSON.parse(localStorage.getItem('ampoteket:cart') ?? '[]') as { product_id: string; quantity: string }[]).find((line) => line.product_id === id)?.quantity ?? null, seedProductId(index));
}
async function fits(page: Page) {
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'Scanner fits the document without horizontal scrolling');
}
function sameGeometry(before: { x: number; y: number; width: number; height: number } | null, after: { x: number; y: number; width: number; height: number } | null, message: string) {
	assert.ok(before && after, message);
	for (const key of ['x', 'y', 'width', 'height'] as const) expect(after[key], message).toBeCloseTo(before[key], 2);
}
async function noInternalScroll(page: Page) {
	assert.ok(await scannerDialog(page).locator('.dialog-body').evaluate((body) => body.scrollHeight <= body.clientHeight + 1), 'Scanner dialog needs no internal scrolling');
}
async function product(page: Page, code = seedProductCode(0)) {
	await state(page, 'product');
	await expect(scannerDialog(page).getByText(code, { exact: true })).toBeVisible();
}

try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	await installCamera(context);
	const page = await context.newPage();
	const errors: string[] = [], requests: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') browserDiagnostics.push(message.text()); });
	page.on('requestfailed', (request) => { if (request.url().startsWith(origin)) browserDiagnostics.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
	page.on('request', (request) => requests.push(request.url()));
	const lookupCodes: string[] = [];
	let lookupMode: 'normal' | 'hold' | 'fail' = 'normal';
	const held: (() => void)[] = [];
	await page.route('**/rest/v1/rpc/amp_catalog', async (route: Route) => {
		const code = route.request().postDataJSON()?.p_code;
		if (typeof code === 'string') {
			lookupCodes.push(code);
			if (lookupMode === 'hold') await new Promise<void>((resume) => held.push(resume));
			if (lookupMode === 'fail') { await route.abort('failed'); return; }
		}
		try { await route.continue(); } catch { /* A cancelled lookup may already be detached. */ }
	});
	for (const locale of ['', '/en']) for (const width of [320, 641, 768, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(origin + (locale || '/'));
		await expect(page.locator('.scanner-trigger')).toBeEnabled({ timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		const geometry = await page.evaluate(() => ({
			height: document.querySelector('.site-header')!.getBoundingClientRect().height,
			expected: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')),
			brandRight: document.querySelector('.site-header img')!.getBoundingClientRect().right,
			cartLeft: document.querySelector('.header-cart')!.getBoundingClientRect().left
		}));
		assert.ok(geometry.height >= geometry.expected && geometry.height <= geometry.expected + 1, `Header stays one row at ${locale || 'nb'} ${width}px`);
		assert.ok(geometry.cartLeft >= geometry.brandRight, `Header controls clear the wordmark at ${locale || 'nb'} ${width}px`);
		await fits(page);
	}
	console.log('PASS: both localized headers fit 320/641/768/1280 px without wrapping or overlapping the wordmark');
	await page.setViewportSize({ width: 1280, height: 900 });
	// Help, checkout and admin have no buyer scanner trigger (design-system §4.1).
	for (const path of ['/en', `/en/p/${seedProductCode(0)}`, '/en/cart', '/en/p?scan=1']) {
		await page.goto(origin + path);
		await expect(page.locator('.scanner-trigger')).toBeEnabled({ timeout: 30000 });
		await expect(scanner(page)).toHaveCount(1);
		await expect(await trigger(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toHaveCount(1);
		await expect(scannerDialog(page)).toHaveCount(0);
		assert.equal((await stats(page)).requests, 0, 'Browsing any route, including an old scan link, does not request the camera');
	}
	assert.equal(requests.filter((url) => /\.wasm(?:\?|$)|decoder\.worker/.test(url)).length, 0, 'Decoder worker/WASM are absent from ordinary page loads');
	await page.goto(`${origin}/en/p`);
	await expect(page.locator('.search-submit')).toBeEnabled({ timeout: 30000 });
	await expect(page.locator('#catalog-search')).toHaveCount(1);
	await expect(page.locator('.scanner-trigger')).toBeHidden();
	await open(page);
	await expect(scannerDialog(page)).toBeVisible();
	await expect(scannerDialog(page).locator('form.manual')).toBeVisible();
	await decodedFrames(page, 2);
	assert.ok(requests.some((url) => /\.wasm(?:\?|$)/.test(url)), 'Scanner lazily requests its actual self-hosted WASM');
	assert.ok((await stats(page)).constraints.every((request) => request.audio === false), 'Camera requests never request the microphone');
	assert.ok((await stats(page)).constraints.every((request) => JSON.stringify(request.video).includes('environment')), 'Rear camera is preferred');
	const video = scannerDialog(page).locator('video.scanner-video');
	assert.ok(await video.evaluate((element: HTMLVideoElement) => element.muted && element.hasAttribute('playsinline')), 'Inline muted playback is configured (Firefox does not expose playsInline as a property)');
	lookupMode = 'hold';
	const firstLookups = lookupCodes.length;
	await paint(page, 'first');
	await state(page, 'resolving');
	await expect.poll(() => held.length).toBe(1);
	const frozen = scannerDialog(page).locator('canvas.scanner-freeze');
	await expect(frozen).toBeVisible();
	const frozenPixels = await frozen.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
	const paused = await stats(page);
	await paint(page, 'second');
	await expect.poll(async () => (await stats(page)).paints).toBeGreaterThan(paused.paints + 10);
	assert.equal((await stats(page)).draws, paused.draws, 'No video frames are decoded while product lookup is pending');
	assert.equal((await stats(page)).live, 1, 'Camera stays warm during lookup');
	assert.equal(await frozen.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()), frozenPixels, 'Frozen successful frame does not change with live video');
	assert.equal(lookupCodes.length, firstLookups + 1, 'Accept gate permits one lookup despite continued camera frames');
	assert.equal(page.url(), `${origin}/en/p`, 'A pending lookup does not navigate anywhere');
	for (const width of [360, 1280]) {
		await page.setViewportSize({ width, height: 900 }); await fits(page); await noInternalScroll(page);
		await page.screenshot({ path: `${artifacts}/en-light-${width}-frozen-camera.png` });
	}
	lookupMode = 'normal'; held.splice(0).forEach((release) => release());
	await product(page);
	assert.equal(page.url(), `${origin}/en/p`, 'Catalog scans keep the current route and show quantity confirmation');
	assert.equal(await quantity(page), null, 'Scanning does not add a product');
	// Only an explicit product-name click navigates, using our validated route.
	await scannerDialog(page).locator(`h3 a[href="/en/p/${seedProductCode(0)}"]`).click();
	await expect(page).toHaveURL(`${origin}/en/p/${seedProductCode(0)}`, { timeout: 20000 });
	await camera(page, 'closed');
	await expect(scannerDialog(page)).toHaveCount(0);
	assert.equal(await quantity(page), null, 'Opening product details leaves the basket untouched');
	await expect.poll(async () => (await stats(page)).live).toBe(0);
	console.log('PASS: one global scanner with lazy real QR WASM; frozen lookup and inline confirmation; explicit product-name navigation releases the camera');

	for (const path of ['/en', `/en/p/${seedProductCode(0)}`, '/en/cart']) {
		await page.goto(origin + path); await open(page);
		await scannerDialog(page).getByLabel(fieldLabel('Part code')).fill(seedProductCode(0));
		await action(page, 'Find part').click(); await product(page);
		await expect(action(page, 'Add to cart')).toBeEnabled();
		assert.equal(page.url(), origin + path, 'Manual lookup confirms in place on every route');
		await action(page, 'Scan').click(); await state(page, 'idle');
		await action(page, 'Close scanner').click(); await camera(page, 'closed');
		assert.equal((await stats(page)).live, 0);
	}
	await page.setViewportSize({ width: 360, height: 640 });
	await page.goto(`${origin}/en`);
	// The hero docks the phone trigger beside the catalog button until it reaches the header;
	// the floating one is hidden from assistive technology meanwhile, so wait on the dock.
	await expect(page.locator('[data-scanner-dock]')).toBeEnabled({ timeout: 30000 });
	await expect(page.locator('[data-scanner-dock]')).toBeVisible();
	await expect(page.locator('.scanner-trigger')).toBeHidden();
	const homeEntry = page.locator('.code-form input');
	await homeEntry.fill('RES-UNSAVED');
	await expect(page.locator('.scanner-trigger')).toBeHidden();
	await homeEntry.press('Tab');
	await expect(page.locator('.scanner-trigger')).toBeVisible();
	const emptyMenu = await page.locator('.menu-toggle').boundingBox();
	const emptyHeader = await page.locator('.site-header').boundingBox();
	await expect(page.locator('.header-cart [data-slot=badge]')).toHaveCount(0);
	await action(page, 'Scan QR code').focus();
	// Measure once the undocking slide-in has finished (it is not scroll-linked motion).
	await page.locator('.scanner-trigger').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
	const topTrigger = await action(page, 'Scan QR code').boundingBox();
	assert.ok(topTrigger && topTrigger.x >= 0 && topTrigger.y > 320 && topTrigger.x + topTrigger.width <= 360 && topTrigger.y + topTrigger.height <= 640, 'Mobile scanner stays within the bottom-right safe area');
	await page.evaluate(() => window.scrollTo(0, 800));
	const readingPosition = await page.evaluate(() => window.scrollY);
	assert.ok(readingPosition > 0, 'Preservation is exercised away from the document top');
	sameGeometry(topTrigger, await action(page, 'Scan QR code').boundingBox(), 'Floating scanner stays stationary while the document scrolls');
	await page.keyboard.press('Enter'); await camera(page, 'scanning');
	await expect(page.locator('.scanner-trigger')).toBeHidden();
	assert.equal(await page.evaluate(() => window.scrollY), readingPosition, 'Opening the scanner preserves the page reading position');
	await page.keyboard.press('Escape'); await camera(page, 'closed');
	await expect(action(page, 'Scan QR code')).toBeFocused();
	assert.equal(await page.evaluate(() => window.scrollY), readingPosition, 'Closing restores focus without scrolling');
	await expect(homeEntry).toHaveValue('RES-UNSAVED');
	await fits(page);
	await expect(scannerDialog(page)).toHaveCount(0);
	await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
	await page.screenshot({ path: `${artifacts}/en-light-360x640-global-trigger.png` });
	await page.setViewportSize({ width: 1280, height: 900 });
	console.log('PASS: home/help/product share manual confirmation; mobile trigger is stationary, clears focused inputs/modals, and preserves keyboard focus, page scroll and unsaved input');

	await page.goto(`${origin}/en/p`);
	await expect(page.locator('.search-submit')).toBeEnabled({ timeout: 30000 });
	await open(page); await decodedFrames(page, 2);
	await paint(page, 'unknown'); await state(page, 'missing');
	await action(page, 'Cancel').click(); await state(page, 'idle');
	await rearm(page);
	const beforeForeign = lookupCodes.length;
	await paint(page, 'foreign'); await state(page, 'invalid');
	assert.equal(lookupCodes.length, beforeForeign, 'Untrusted payload rejected before backend lookup');
	await action(page, 'Cancel').click();
	await action(page, 'Close scanner').click(); await camera(page, 'closed');
	assert.equal((await stats(page)).live, 0, 'Closing the dialog stops all camera tracks');
	console.log('PASS: unknown and foreign labels recover inside the catalog dialog without navigation; closing releases the camera');

	await page.goto(`${origin}/en/cart`);
	await open(page); await decodedFrames(page, 2);
	const manualEntry = scannerDialog(page).getByLabel(fieldLabel('Part code'));
	const findPart = scannerDialog(page).locator('form.manual button[type=submit]');
	await expect(findPart).toBeDisabled();
	for (const invalid of ['   ', 'RES 00001', 'https://evil.test/p/RES-00001', 'https://ampoteket.no/p/RES-00001?x=1']) {
		await manualEntry.fill(invalid); await expect(findPart).toBeDisabled();
	}
	for (const valid of [' res-00001 ', 'ampoteket.no/p/RES-00001', 'https://ampoteket.no/p/RES-00001']) {
		await manualEntry.fill(valid); await expect(findPart).toBeEnabled();
	}
	await manualEntry.fill(''); await expect(findPart).toBeDisabled();
	const idleLookupGeometry = await scannerDialog(page).boundingBox();
	const idleEntryGeometry = await manualEntry.boundingBox();
	lookupMode = 'hold'; await paint(page, 'first'); await state(page, 'resolving');
	sameGeometry(idleLookupGeometry, await scannerDialog(page).boundingBox(), 'Pending scan keeps the dialog geometry until the product is ready');
	sameGeometry(idleEntryGeometry, await manualEntry.boundingBox(), 'Pending scan keeps manual entry in place');
	await expect.poll(() => held.length).toBe(1);
	await expect(frozen).toBeVisible();
	await action(page, 'Cancel').click(); await state(page, 'idle');
	lookupMode = 'normal'; held.splice(0).forEach((release) => release());
	await decodedFrames(page, 5); await state(page, 'idle');
	await rearm(page); lookupMode = 'fail'; await paint(page, 'first'); await state(page, 'unavailable');
	assert.equal((await stats(page)).live, 1, 'Lookup failure does not stop the camera');
	lookupMode = 'normal'; await action(page, 'Search again').click(); await product(page);
	// Scanner confirmation uses the same purchase validation as product details.
	const purchaseQuantity = scannerDialog(page).getByLabel(fieldLabel('Quantity'));
	const increase = scannerDialog(page).getByRole('button', { name: /^Increase / });
	await expect(increase).toHaveCSS('touch-action', 'manipulation');
	await increase.dblclick();
	await expect(purchaseQuantity).toHaveValue('3');
	await purchaseQuantity.fill('0.5');
	await action(page, 'Add to cart').click();
	await expect(purchaseQuantity).toHaveAttribute('aria-invalid', 'true');
	await expect(purchaseQuantity).toBeFocused();
	await expect(scannerDialog(page).locator('.basket-error')).toContainText('Enter a valid quantity');
	assert.equal(await quantity(page), null, 'Invalid quantity never mutates the basket');
	await state(page, 'product');
	await purchaseQuantity.fill('1');
	const cartLookups = lookupCodes.length;
	await action(page, 'Add to cart').click();
	await expect.poll(() => quantity(page)).toBe('1');
	await state(page, 'idle');
	await expect(frozen).toBeHidden();
	// The cart page itself re-reads facts for its one new line; wait for that
	// single page-owned lookup so scanner suppression is measured alone.
	await expect.poll(() => lookupCodes.length).toBe(cartLookups + 1);
	const afterAddLookups = lookupCodes.length;
	await decodedFrames(page, 8);
	await state(page, 'idle');
	assert.equal(lookupCodes.length, afterAddLookups, 'A stationary previously accepted label is suppressed after Add');
	await rearm(page); await paint(page, 'first'); await product(page);
	await expect(scannerDialog(page).getByText(en.product.already('1', 'piece'), { exact: true })).toBeVisible();
	await action(page, 'Add to cart').click();
	await expect.poll(() => quantity(page)).toBe('2');
	await decodedFrames(page, 5); await state(page, 'idle');
	await action(page, 'Scan same label again').click();
	await product(page); await action(page, 'Scan').click();
	await decodedFrames(page, 5); await state(page, 'idle');
	assert.equal(await quantity(page), '2', 'Scan leaves the basket unchanged');
	await noInternalScroll(page);
	console.log('PASS: cancelled slow lookup cannot reopen confirmation; failed lookup retries; basket add/scan resumes live scanning in the dialog; stationary suppression and later deliberate same-product scan');

	// Two fully visible labels in the actual 80% crop: prefer the one nearest its
	// center, independent of the decoder result array's order.
	await rearm(page);
	await page.evaluate(() => window.cameraProof.scene([
		{ label: 'second', x: 355, y: 355, size: 190 },
		{ label: 'first', x: 100, y: 100, size: 190 }
	]));
	await product(page, seedProductCode(1)); await action(page, 'Scan').click();
	await rearm(page);
	// A whole code outside the crop cannot trigger a product interaction.
	await page.evaluate(() => window.cameraProof.scene([{ label: 'first', x: 0, y: 350, size: 80 }]));
	const beforeOutside = lookupCodes.length;
	await decodedFrames(page, 8); await state(page, 'idle');
	assert.equal(lookupCodes.length, beforeOutside);
	for (const label of ['foreign', 'malformed', 'plain']) {
		await rearm(page); const before = lookupCodes.length;
		await paint(page, label); await state(page, 'invalid');
		assert.equal(lookupCodes.length, before, 'Untrusted payload rejected before backend lookup');
		await action(page, 'Cancel').click();
	}
	await rearm(page); await paint(page, 'unknown'); await state(page, 'missing');
	await action(page, 'Cancel').click();
	assert.ok(requests.every((url) => [origin, api.origin].includes(new URL(url).origin)), 'No QR URL or third-party CDN is fetched');
	console.log('PASS: real decoder crop/center choice with two labels; malformed, plain, foreign and unknown payloads; no payload navigation or external requests');

	await rearm(page); await paint(page, 'first'); await product(page);
	await page.evaluate(() => window.cameraProof.denyBasket(true));
	await action(page, 'Add to cart').click();
	await state(page, 'product');
	await expect(scannerDialog(page).locator('.basket-error')).toContainText('Check your cart');
	assert.equal(await quantity(page), '2', 'A rejected basket write preserves saved quantity');
	assert.equal((await stats(page)).live, 1);
	await expect(action(page, 'Add to cart')).toBeDisabled();
	await page.evaluate(() => window.cameraProof.denyBasket(false));
	await action(page, 'Scan').click();
	// A failed read-back could follow a successful write. Never blindly retry an
	// add: review the persisted basket before a new intentional scan.
	await action(page, 'Close scanner').click(); await camera(page, 'closed');
	assert.equal((await stats(page)).live, 0, 'Closing stops all camera tracks');
	await expect(page.locator('.cart-line input[inputmode=decimal]').first()).toHaveValue('2');
	await page.setViewportSize({ width: 360, height: 640 });
	await page.goto(`${origin}/en/contact`);
	const mobileCart = page.locator('.header-cart');
	await expect(mobileCart).toBeVisible();
	await expect(mobileCart).toHaveAttribute('href', '/en/cart');
	await expect(mobileCart).toHaveAccessibleName(`${en.header.cart}${en.header.cartLines(1)}`);
	sameGeometry(emptyMenu, await page.locator('.menu-toggle').boundingBox(), 'A nonempty basket does not move the hamburger');
	sameGeometry(emptyHeader, await page.locator('.site-header').boundingBox(), 'A nonempty basket does not resize the header');
	const cartBox = await mobileCart.boundingBox();
	assert.ok(cartBox && emptyMenu && cartBox.x + cartBox.width <= emptyMenu.x && cartBox.width >= 44 && cartBox.height >= 44, 'Mobile cart is a full-size control left of the hamburger');
	await mobileCart.click(); await expect(page).toHaveURL(`${origin}/en/cart`);
	await expect(page.locator('.cart-line input[inputmode=decimal]').first()).toHaveValue('2');
	await fits(page);
	await page.screenshot({ path: `${artifacts}/en-light-360x640-cart-shortcut.png` });
	await page.setViewportSize({ width: 1280, height: 900 });
	console.log('PASS: uncertain basket write retains confirmation, disables repeated Add and requires basket review before another addition');

	// Camera denial retains the same manual path on every page.
	await page.evaluate(() => window.cameraProof.mode('deny'));
	await (await trigger(page)).click(); await camera(page, 'denied');
	await scannerDialog(page).getByLabel(fieldLabel('Part code')).fill(seedProductCode(1).toLowerCase());
	await action(page, 'Find part').click(); await product(page, seedProductCode(1));
	await action(page, 'Scan').click();
	await page.evaluate(() => window.cameraProof.mode('live'));
	await paint(page, null); await action(page, 'Retry camera').click(); await camera(page, 'scanning');
	await decodedFrames(page, 2);
	await page.evaluate(() => window.cameraProof.hidden(true));
	await camera(page, 'interrupted'); assert.equal((await stats(page)).live, 0);
	await page.evaluate(() => window.cameraProof.hidden(false));
	await action(page, 'Retry camera').click(); await camera(page, 'scanning');
	await paint(page, 'first'); await product(page);
	await page.evaluate(() => window.cameraProof.hidden(true));
	await camera(page, 'interrupted'); await state(page, 'product');
	await page.evaluate(() => window.cameraProof.hidden(false));
	await action(page, 'Scan').click();
	await paint(page, null); await action(page, 'Retry camera').click(); await camera(page, 'scanning');
	await page.evaluate(() => window.cameraProof.end());
	await camera(page, 'interrupted'); assert.equal((await stats(page)).live, 0);
	await action(page, 'Retry camera').click(); await camera(page, 'scanning');
	console.log('PASS: camera denial retains manual entry; retry works; synthetic visibility and track interruption stop resources, preserve confirmation and permit explicit camera recovery');

	await action(page, 'Close scanner').click();
	await page.evaluate(() => window.cameraProof.mode('delay'));
	await (await trigger(page)).click();
	await expect.poll(async () => (await stats(page)).delayed).toBe(1);
	const stoppedBeforeLateGrant = (await stats(page)).stopped;
	// Escape is the modal's exit while startup is still pending; a late grant
	// after it must be stopped immediately.
	await page.keyboard.press('Escape'); await camera(page, 'closed');
	await page.evaluate(() => window.cameraProof.release());
	await expect.poll(async () => (await stats(page)).stopped).toBeGreaterThan(stoppedBeforeLateGrant);
	await expect.poll(async () => (await stats(page)).live).toBe(0);
	await page.evaluate(() => window.cameraProof.mode('live'));
	await paint(page, null); await open(page);
	await decodedFrames(page, 2); await paint(page, 'second'); await product(page, seedProductCode(1));
	await action(page, 'Add to cart').click(); await expect.poll(() => quantity(page, 1)).toBe('1');
	await action(page, 'Close scanner').click();
	console.log('PASS: Escape during pending camera startup closes the dialog and stops the late-granted stream; the reopened scanner adds products on the basket page');

	for (const locale of ['', '/en']) for (const colour of ['light', 'dark'] as const) for (const width of [360, 1280]) {
		await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: colour });
		await page.goto(`${origin}${locale}/cart`);
		await (await trigger(page, locale ? 'Scan QR code' : 'Skann QR-kode')).click();
		await scannerDialog(page).getByLabel(fieldLabel(locale ? 'Part code' : 'Delekode')).fill(seedProductCode(0));
		await camera(page, 'scanning');
		await scannerDialog(page).evaluate(async (dialog) => { await Promise.all(dialog.getAnimations().map((animation) => animation.finished)); });
		const idleBox = await scannerDialog(page).boundingBox();
		const input = scannerDialog(page).locator('form.manual input');
		const inputBox = await input.boundingBox();
		lookupMode = 'hold';
		await scannerDialog(page).locator('form.manual button[type=submit]').click(); await state(page, 'resolving');
		await expect.poll(() => held.length).toBeGreaterThan(0);
		sameGeometry(idleBox, await scannerDialog(page).boundingBox(), 'Lookup does not resize or move the dialog in either locale/theme');
		sameGeometry(inputBox, await input.boundingBox(), 'Lookup preserves the input position on phone and desktop');
		lookupMode = 'normal'; held.splice(0).forEach((release) => release());
		await state(page, 'product');
		await fits(page); await noInternalScroll(page);
		await page.screenshot({ path: `${artifacts}/${locale ? 'en' : 'nb'}-${colour}-${width}-confirmation.png` });
		await page.keyboard.press('Escape'); await camera(page, 'closed');
	}
	// Long names and the existing basket quantity must also fit a short phone.
	await page.setViewportSize({ width: 360, height: 640 });
	for (const locale of ['', '/en']) for (const colour of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: colour });
		await page.goto(`${origin}${locale}/cart`);
		await (await trigger(page, locale ? 'Scan QR code' : 'Skann QR-kode')).click();
		await camera(page, 'scanning');
		await scannerDialog(page).evaluate(async (dialog) => { await Promise.all(dialog.getAnimations().map((animation) => animation.finished)); });
		await scannerDialog(page).getByLabel(fieldLabel(locale ? 'Part code' : 'Delekode')).fill(seedProductCode(0));
		await scannerDialog(page).locator('form.manual button[type=submit]').click(); await state(page, 'product');
		await expect(scannerDialog(page).locator('.basket-error')).toContainText(locale ? '2 pieces' : '2 stk');
		await fits(page); await noInternalScroll(page);
		// Tapping the terse coordinates explains them without leaving the confirmation.
		const where = scannerDialog(page).getByRole('button', { name: locale ? /^Cabinet A1\s*, Drawer A1$/ : /^Kabinett A1\s*, Skuff A1$/ });
		await where.click();
		await expect(page.locator('[data-slot=popover-content]')).toContainText(locale ? 'Drawer' : 'Skuff');
		await state(page, 'product'); await fits(page);
		await page.screenshot({ path: `${artifacts}/${locale ? 'en' : 'nb'}-${colour}-360x640-location.png` });
		await where.click(); await expect(page.locator('[data-slot=popover-content]')).toHaveCount(0);
		await page.screenshot({ path: `${artifacts}/${locale ? 'en' : 'nb'}-${colour}-360x640-confirmation.png` });
		await page.keyboard.press('Escape'); await camera(page, 'closed');
	}
	// Maximum supported names may need the explicit overflow fallback. Its
	// region scrolls by keyboard while confirmation controls stay in the footer.
	const previousName = await sql(`SELECT name_en FROM app.products WHERE id='${seedProductId(0)}'`);
	try {
		await sql(`UPDATE app.products SET name_en=repeat('W',200) WHERE id='${seedProductId(0)}'`);
		await page.goto(`${origin}/en/cart`); await open(page);
		await scannerDialog(page).getByLabel(fieldLabel('Part code')).fill(seedProductCode(0));
		await action(page, 'Find part').click(); await product(page);
		const body = scannerDialog(page).getByRole('region', { name: en.scanner.contents, exact: true });
		await expect.poll(() => body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		await body.focus(); await body.press('End');
		await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		for (const label of ['Add to cart', 'Scan']) {
			const control = action(page, label);
			assert.equal(await control.evaluate(element => element.closest('.dialog-body')), null);
			const box = await control.boundingBox();
			assert.ok(box && box.y >= 0 && box.y + box.height <= 640, 'Scanner confirmation stays visible below its scrolling content');
		}
		await fits(page); await action(page, 'Close scanner').click(); await camera(page, 'closed');
	} finally {
		await sql(`UPDATE app.products SET name_en='${previousName.replaceAll("'", "''")}' WHERE id='${seedProductId(0)}'`);
	}
	console.log('PASS: scanner long-name overflow is named and keyboard-scrollable, with Add/Scan outside it');
	await page.setViewportSize({ width: 1280, height: 900 });
	// Complete the actual paid flow on disposable stock. This deliberately does
	// not open Vipps or claim payment/app-switching acceptance.
	await page.goto(`${origin}/en/cart`);
	await page.getByRole('button', { name: 'Go to checkout', exact: true }).click();
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toBeVisible({ timeout: 30000 });
	// Checkout itself has no buyer scanner (design-system §4.1); scanning from the cart
	// while that checkout is open must respect its lock.
	const checkoutUrl = page.url();
	await page.goto(`${origin}/en/cart`);
	await open(page);
	await scannerDialog(page).getByLabel(fieldLabel('Part code')).fill(seedProductCode(0));
	await action(page, 'Find part').click(); await product(page);
	await expect(action(page, 'Add to cart')).toBeDisabled();
	await expect(scannerDialog(page).getByLabel(fieldLabel('Quantity'))).toBeDisabled();
	assert.equal(await quantity(page), '2', 'Global scanner respects the active checkout lock');
	await action(page, 'Close scanner').click(); await camera(page, 'closed');
	await page.goto(checkoutUrl);
	await page.getByRole('button', { name: 'I have paid, register purchase', exact: true }).click();
	await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible();
	assert.equal(await sql('SELECT count(*) FROM app.sales'), '1');
	await expect.poll(() => quantity(page)).toBeNull();
	await page.setViewportSize({ width: 360, height: 640 });
	await expect(page.locator('.header-cart [data-slot=badge]')).toHaveCount(0);
	sameGeometry(emptyMenu, await page.locator('.menu-toggle').boundingBox(), 'Emptying the basket keeps the hamburger in place');
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${origin}/en/cart`); await open(page);
	await paint(page, 'free'); await product(page, seedProductCode(27));
	await action(page, 'Add to cart').click(); await expect.poll(() => quantity(page, 27)).toBe('1');
	await action(page, 'Close scanner').click();
	await page.getByRole('button', { name: 'Go to checkout', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Complete purchase', exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Complete purchase', exact: true }).click();
	await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible();
	assert.equal(await sql('SELECT count(*) FROM app.sales'), '2');
	assert.deepEqual(errors, [], 'No browser runtime errors');
	console.log('PASS: both locales/themes fit 360/1280 px; actual scan → basket → saved payment controls → registration and a free collection each post one disposable sale');
	// CI sometimes stalled from here until its 30-minute limit, on calls Playwright never
	// times out (close, evaluate). Name the step and fail instead; the forced exit covers
	// a cleanup that stalls on the same browser.
	let webkitStep = 'closing Firefox';
	const watchdog = setTimeout(() => {
		console.error(`Scanner proof stalled for 3 minutes while ${webkitStep}.`);
		setTimeout(() => process.exit(1), 20000).unref();
		process.kill(process.pid, 'SIGTERM');
	}, 180000);
	watchdog.unref();
	await context.close(); context = undefined;
	webkitStep = 'launching WebKit';

	// Desktop WebKit blocks the local HTTPS page's loopback HTTP API. A test-only
	// loopback HTTP transport forwards the identical production app/assets with
	// verified TLS upstream. localhost remains a secure camera context; this is
	// neither a production proxy nor evidence for a physical iPhone/Safari.
	const webkitBrowser = await webkit.launch({ headless: true });
	const webkitTransport = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
		const incoming = new URL(request.url);
		const headers = new Headers(request.headers); headers.delete('host');
		// A request WebKit abandons (it closes mid-load) must abort upstream too, or its
		// handler never settles and stop() below waits for it forever.
		const response = await fetch(origin + incoming.pathname + incoming.search, {
			method: request.method, headers, tls: { ca }, redirect: 'manual', signal: request.signal,
			body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
		});
		return new Response(response.body, { status: response.status, headers: response.headers });
	} });
	try {
		webkitStep = 'opening the WebKit cart';
		context = await webkitBrowser.newContext({ viewport: { width: 390, height: 844 } });
		await installCamera(context);
		const webkitPage = await context.newPage();
		const webkitErrors: string[] = [];
		webkitPage.on('pageerror', (error) => webkitErrors.push(error.message));
		await webkitPage.goto(`http://localhost:${webkitTransport.port}/en/cart`); await open(webkitPage);
		webkitStep = 'scanning the first label in WebKit';
		await paint(webkitPage, 'first'); await product(webkitPage); await noInternalScroll(webkitPage);
		await action(webkitPage, 'Add to cart').click(); await expect.poll(() => quantity(webkitPage)).toBe('1');
		await decodedFrames(webkitPage, 5); await state(webkitPage, 'idle');
		webkitStep = 'rescanning in WebKit';
		await rearm(webkitPage); await paint(webkitPage, 'first'); await product(webkitPage);
		await action(webkitPage, 'Scan').click(); await action(webkitPage, 'Close scanner').click();
		assert.equal((await stats(webkitPage)).live, 0); await fits(webkitPage);
		assert.deepEqual(webkitErrors, []);
		webkitStep = 'closing the WebKit context';
		await context.close(); context = undefined;
	} finally { webkitStep = 'closing WebKit'; await webkitBrowser.close(); void webkitTransport.stop(true); }
	clearTimeout(watchdog);
	console.log('PASS: desktop WebKit real WASM scan/add/repeat/rescan/cleanup with synthetic media through a test-only localhost HTTP transport');
	console.log('EVIDENCE LIMIT: no physical iPhone/Android camera, permission prompt, lock/unlock, printed-label optics or Vipps app behavior is proven by this suite.');
} catch (error) {
	try {
		const current = context?.pages().at(-1);
		if (current) {
			await current.screenshot({ path: `${artifacts}/failure.png`, fullPage: true });
			console.error('Scanner failure state:', await current.locator('.scanner').evaluateAll((sections) => sections.map((section) => ({ state: section.getAttribute('data-state'), camera: section.getAttribute('data-camera') }))));
		}
	} catch { /* Keep the original failure. */ }
	console.error('Browser diagnostics:', browserDiagnostics);
	throw error;
} finally { await close(); }
