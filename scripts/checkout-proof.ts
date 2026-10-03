/** Actual pages and gateway, disposable PostgreSQL/Auth, trusted HTTPS and real browser storage. */
import { firefox, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { post, proofEnvironment } from './web-proof/harness';
import type { ActiveAttempt } from '../src/lib/cart';
import type { CheckoutSnapshot } from '../src/lib/checkout-contract';

// Hooks the storage-failure cases below install in the page to undo their patches.
declare global { interface Window { restoreStorage(): void; restoreIdb(): void; restoreRead(): void } }

const { directory, origin, api, publicKey, serviceKey, password, secrets, safe, ca, sql, createUser, startWorker } = await proofEnvironment();
const staffEmail = 'checkout-staff@example.test';
const nonstaffEmail = 'checkout-nonstaff@example.test';
const staffId = await createUser(staffEmail);
await createUser(nonstaffEmail);
const mailpitPort = Number(process.argv[5]);
assert.ok(Number.isInteger(mailpitPort) && mailpitPort > 0 && mailpitPort <= 65535, 'Use scripts/test-web.sh --checkout');
const passwordReturn = `${origin}/en/admin/password?next=%2Fadmin`;
async function inviteAuthUser(email: string): Promise<void> {
	const response = await fetch(`${api.origin}/auth/v1/invite?redirect_to=${encodeURIComponent(passwordReturn)}`, {
		method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ email })
	});
	assert.ok(response.ok, `Local Auth sends a disposable invitation (${response.status})`);
	await response.body?.cancel();
}
async function readAuthEmail(type: 'invite' | 'recovery', email: string): Promise<string> {
	const mailbox = `http://127.0.0.1:${mailpitPort}/view/latest.html?query=${encodeURIComponent(`to:${email}`)}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await fetch(mailbox);
		if (response.ok) {
			const html = await response.text();
			const link = html.match(/<a href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
			assert.ok(link, 'Rendered Auth email contains a password link');
			const url = new URL(link);
			assert.equal(url.origin, origin);
			assert.equal(url.pathname, '/en/admin/password');
			assert.equal(url.searchParams.get('next'), '/admin');
			assert.equal(url.searchParams.get('type'), type);
			const token = url.searchParams.get('token_hash');
			assert.match(token ?? '', /^(?:pkce_)?[a-f0-9]{32,256}$/);
			secrets.push(token!);
			return url.href;
		}
		assert.equal(response.status, 404, 'Mailpit mailbox read');
		await Bun.sleep(100);
	}
	throw new Error('Local Auth email was not delivered to Mailpit');
}
await sql((await Bun.file('scripts/web-proof/fixtures.sql').text()).replace(":'staff_id'", `'${staffId}'`));
await sql(`INSERT INTO app.help_contacts(display_name,email,is_published)
 SELECT 'Proof volunteer ' || n, 'volunteer' || n || '@example.test', true FROM generate_series(1,5) n ORDER BY n;
 INSERT INTO app.help_contacts(display_name,email,is_published) VALUES ('Private directory draft','draft@example.test',false);
 NOTIFY pgrst, 'reload schema';`);
const bundle = await Bun.build({ entrypoints: ['scripts/checkout-browser-probe.ts'], outdir: `${directory}/probe`, target: 'browser' });
assert.ok(bundle.success, 'Browser persistence probe builds');
let context: BrowserContext | undefined;
const { ready, close, restart } = await startWorker(() => context);
const artifacts = resolve('test-results/checkout');
await mkdir(artifacts, { recursive: true });
async function probe(page: Page) {
	await page.addScriptTag({ path: `${directory}/probe/checkout-browser-probe.js`, type: 'module' });
	await page.waitForFunction(() => 'checkoutProof' in window);
}
async function call<T>(page: Page, method: string, args: unknown[] = []): Promise<T> {
	return page.evaluate(async ({ method, args }) => {
		const proof = (window as unknown as { checkoutProof: Record<string, (...args: unknown[]) => Promise<unknown>> }).checkoutProof;
		return proof[method](...args);
	}, { method, args }) as Promise<T>;
}
async function fails(page: Page, method: string, args: unknown[] = []) {
	let failed = false;
	try { await call(page, method, args); } catch { failed = true; }
	assert.ok(failed, `${method} must fail visibly`);
}
const paidProduct = '73000000-0000-4000-8000-000000000001';
const freeProduct = '73000000-0000-4000-8000-000000000002';
async function basket(page: Page, id = paidProduct) {
	assert.equal(await call(page, 'readActiveAttempt'), null, 'No unresolved checkout discarded by fixture');
	await page.evaluate((product_id) => localStorage.setItem('ampoteket:cart', JSON.stringify([{ product_id, quantity: '1' }])), id);
}
async function begin(page: Page, id = paidProduct): Promise<ActiveAttempt> {
	await basket(page, id);
	const attempt = await call<ActiveAttempt>(page, 'startCheckout', ['private-test-contact']);
	return call<ActiveAttempt>(page, 'prepareCheckout', [attempt]);
}
async function complete(page: Page, attempt: ActiveAttempt) {
	const snapshot = await call<CheckoutSnapshot>(page, 'confirmCheckout', [attempt]);
	await call(page, 'finishRegistration', [attempt, snapshot]);
	return snapshot;
}
async function commitThenDrop(route: Route) {
	// Playwright's API transport does not use Firefox's disposable CA store.
	// Forward with explicit CA verification; do not disable certificate checking.
	const request = route.request();
	const result = await fetch(request.url(), {
		method: request.method(), headers: await request.allHeaders(), body: request.postData(),
		tls: { ca }, redirect: 'manual'
	});
	assert.equal(result.status, 200, 'Intercepted checkout request commits successfully');
	await result.body?.cancel();
	await route.abort('failed');
}
try {
	await ready();
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const errors: string[] = [];
	context.on('page', (tab) => tab.on('pageerror', (error) => errors.push(error.message)));
	const page = await context.newPage();
	await page.goto(`${origin}/en/cart`); await probe(page);
	await basket(page);
	// Browser starts via the real cart action; prepare commits, but its response is lost.
	let droppedPrepare = false;
	await page.route('**/api/checkouts/prepare', async (route) => {
		await commitThenDrop(route); droppedPrepare = true;
	}, { times: 1 });
	await page.reload();
	await page.getByRole('button', { name: 'Go to checkout', exact: true }).click();
	await expect.poll(() => droppedPrepare).toBe(true);
	await probe(page);
	const lost = await call<ActiveAttempt>(page, 'readActiveAttempt');
	assert.equal(lost.state, 'preparing'); assert.equal(lost.checkoutId, undefined);
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${lost.requestId}'`), '1');
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	// The other tab sees the same claim, but lacks the private frozen payload.
	const other = await context.newPage(); await other.goto(`${origin}/en/cart`); await probe(other);
	assert.equal((await call<ActiveAttempt>(other, 'startCheckout', ['ignored other payload'])).requestId, lost.requestId);
	await fails(other, 'prepareCheckout', [lost]);
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page).toHaveURL(/\/en\/checkout\/[a-f0-9-]{36}$/);
	await probe(page);
	const prepared = await call<ActiveAttempt>(page, 'readActiveAttempt');
	assert.ok(prepared.checkoutId);
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${lost.requestId}'`), '1');
	const saved = await call<CheckoutSnapshot>(page, 'readCheckout', [prepared]);
	assert.equal(saved.items[0].unit_price_nok, '999999999998.999999');
	assert.equal(saved.total_nok, '999999999999.00');
	assert.equal(await page.evaluate((id) => sessionStorage.getItem('ampoteket:prepare:' + id), prepared.requestId), null);
	const rootCookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-amp_checkout')!;
	secrets.push(rootCookie.value);
	assert.ok(rootCookie.secure && rootCookie.httpOnly && rootCookie.sameSite === 'Lax' && rootCookie.path === '/');
	assert.equal(await page.evaluate(() => document.cookie.includes('__Host-amp_checkout')), false);
	// A transient saved-snapshot failure must recover through the visible retry,
	// with the existing credential and checkout, before payment becomes available.
	await page.route(`**/api/checkouts/${prepared.checkoutId}`, (route) => route.abort('failed'));
	await page.reload();
	await expect(page.getByText('The purchase is unavailable right now. Try again in a moment.', { exact: true })).toBeVisible();
	await expect(page.getByText(prepared.checkoutId, { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	await probe(page);
	assert.deepEqual(await call(page, 'readActiveAttempt'), prepared);
	await page.unroute(`**/api/checkouts/${prepared.checkoutId}`);
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toBeVisible();
	assert.deepEqual(await call(page, 'readActiveAttempt'), prepared);
	assert.deepEqual(await call(page, 'readCheckout', [prepared]), saved);
	assert.equal((await context.cookies()).find(cookie => cookie.name === rootCookie.name)?.value, rootCookie.value);
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${prepared.requestId}'`), '1');
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${prepared.checkoutId}'`), '0');
	console.log('PASS: failed snapshot read retries successfully through the page with the original credential, saved amount and no registration');
	await sql(`UPDATE app.products SET sale_unit_price_nok=1,name_en='Changed current name',is_active=false WHERE id='${paidProduct}'`);
	await page.goto(`${origin}/en/checkout/${prepared.checkoutId}`);
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toBeVisible();
	await expect(page.getByText('Proof capacitor', { exact: true })).toBeVisible();
	await expect(page.getByText(`Ref: ${prepared.checkoutId}`, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
	await expect(page.getByText('Changed current name', { exact: true })).toHaveCount(0);
	assert.equal(await page.locator('link[rel=canonical], meta[property="og:url"]').count(), 0);
	const shell = await fetch(page.url(), { tls: { ca } });
	assert.equal(shell.headers.get('cache-control'), 'no-store');
	assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
	assert.equal(shell.headers.get('content-security-policy'), "frame-ancestors 'none'");
	assert.ok(!(await shell.text()).includes('private-test-contact'));
	for (const path of [`/en/%63heckout/${prepared.checkoutId}`, '/%61dmin/login']) {
		const encoded = await fetch(origin + path, { tls: { ca } });
		assert.equal(encoded.status, 200);
		assert.equal(encoded.headers.get('cache-control'), 'no-store');
		assert.equal(encoded.headers.get('referrer-policy'), 'no-referrer');
		assert.equal(encoded.headers.get('content-security-policy'), "frame-ancestors 'none'");
		assert.ok(!/<(?:link[^>]+rel="canonical"|meta[^>]+property="og:url")/.test(await encoded.text()));
	}
	for (const locale of ['', '/en']) for (const colorScheme of ['light', 'dark'] as const) for (const width of [360, 1280]) {
		await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 900 });
		await page.goto(`${origin}${locale}/checkout/${prepared.checkoutId}`);
		await expect(page.locator('a[href="https://qr.vipps.no/vp/swDrxGWcp"]')).toBeVisible();
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
		await page.screenshot({ path: `${artifacts}/checkout-${locale ? 'en' : 'nb'}-${colorScheme}-${width}.png`, fullPage: true });
	}
	await page.goto(`${origin}/en/checkout/${prepared.checkoutId}`);
	await expect(page.getByRole('button', { name: 'I have paid, register purchase', exact: true })).toBeVisible();
	// Confirm commits; lost response + failed read must keep registration ambiguity durable.
	await page.route(`**/api/checkouts/${prepared.checkoutId}/confirm`, async (route) => {
		await commitThenDrop(route);
	}, { times: 1 });
	await page.route(`**/api/checkouts/${prepared.checkoutId}`, (route) => route.abort('failed'));
	await page.getByRole('button', { name: 'I have paid, register purchase', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Try registering again', exact: true })).toBeVisible();
	await probe(page);
	assert.equal((await call<ActiveAttempt>(page, 'readActiveAttempt')).state, 'confirming');
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	await fails(page, 'setAsideCheckout', [prepared]);
	await page.unroute(`**/api/checkouts/${prepared.checkoutId}`);
	await restart();
	await page.reload();
	await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible();
	await probe(page);
	await expect.poll(() => call<ActiveAttempt | null>(page, 'readActiveAttempt')).toBeNull();
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${prepared.checkoutId}'`), '1');
	assert.equal(await sql(`SELECT count(*) FROM app.inventory_movements m JOIN app.sales s ON s.event_id=m.event_id WHERE s.checkout_id='${prepared.checkoutId}'`), '1');
	// Receipts: the proof Worker has no Resend key, so a valid address reaches the real 503.
	const receiptEmail = page.getByLabel('Email for receipt', { exact: true });
	const sendReceipt = page.getByRole('button', { name: 'Send receipt', exact: true });
	await receiptEmail.fill('98765432'); await sendReceipt.click();
	await expect(page.getByText('Enter a valid email address.', { exact: true })).toBeVisible();
	await receiptEmail.fill('buyer@example.test'); await sendReceipt.click();
	await expect(page.getByText("The receipt wasn't sent. Try again in a moment.", { exact: true })).toBeVisible();
	await page.route(`**/api/checkouts/${prepared.checkoutId}/receipt`, (route) => route.fulfill({ json: { sent: true } }), { times: 1 });
	await sendReceipt.click();
	await expect(page.getByRole('button', { name: 'Sent', exact: true })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'The receipt was sent to buyer@example.test.' })).toHaveCount(1);
	assert.equal(await sql(`SELECT count(*) FROM app.checkout_contacts WHERE contact_text LIKE '%buyer@example.test%'`), '0');
	console.log('PASS: actual cart/checkout, lost prepare and confirmation, exact frozen amounts, cross-tab payload ownership, Worker restart and one withdrawal');
	await sql(`UPDATE app.products SET is_active=true WHERE id='${paidProduct}'`);
	// A registered old page must not remove a new active checkout or its basket.
	const free = await begin(page, freeProduct);
	await page.goto(`${origin}/en/checkout/${prepared.checkoutId}`);
	await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible(); await probe(page);
	assert.equal((await call<ActiveAttempt>(page, 'readActiveAttempt')).requestId, free.requestId);
	assert.ok((await page.evaluate(() => localStorage.getItem('ampoteket:cart')))?.includes(freeProduct));
	await page.goto(`${origin}/en/checkout/${free.checkoutId}`);
	await expect(page.getByRole('button', { name: 'Complete purchase', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	await probe(page); await probe(other);
	const [a, b] = await Promise.all([call<CheckoutSnapshot>(page, 'confirmCheckout', [free]), call<CheckoutSnapshot>(other, 'confirmCheckout', [free])]);
	assert.deepEqual(a, b); await call(page, 'finishRegistration', [free, a]);
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${free.checkoutId}'`), '1');
	console.log('PASS: zero-total checkout, duplicate tab confirmations, completed old checkout preserves newer basket');
	// Read-back denial cannot expose payment; storage loss cannot silently start a replacement.
	await basket(page);
	await page.evaluate(() => { const old = Storage.prototype.setItem; window.restoreStorage = () => Storage.prototype.setItem = old;
		Storage.prototype.setItem = function(key, value) { if (this === sessionStorage) throw new DOMException('Denied', 'SecurityError'); old.call(this, key, value); }; });
	await fails(page, 'startCheckout', ['']);
	assert.equal(await call(page, 'readActiveAttempt'), null);
	await page.evaluate(() => window.restoreStorage());
	const denied = await call<ActiveAttempt>(page, 'startCheckout', ['']);
	const frozenPayload = await page.evaluate((id) => sessionStorage.getItem('ampoteket:prepare:' + id), denied.requestId);
	await page.evaluate(() => { const old = IDBObjectStore.prototype.put; window.restoreIdb = () => IDBObjectStore.prototype.put = old;
		IDBObjectStore.prototype.put = function(value, key) { if (value?.checkoutId) throw new DOMException('Denied', 'QuotaExceededError'); return old.call(this, value, key); }; });
	await fails(page, 'prepareCheckout', [denied]);
	assert.equal((await call<ActiveAttempt>(page, 'readActiveAttempt')).checkoutId, undefined);
	assert.equal(await call(page, 'canOpenPayment', [denied]), false);
	const committedId = await sql(`SELECT id FROM app.checkouts WHERE request_id='${denied.requestId}'`);
	assert.match(committedId, /^[a-f0-9-]{36}$/, 'Prepare committed before its local acknowledgement failed');
	assert.equal(await page.evaluate((id) => sessionStorage.getItem('ampoteket:prepare:' + id), denied.requestId), frozenPayload);
	await page.evaluate(() => window.restoreIdb());
	const restored = await call<ActiveAttempt>(page, 'prepareCheckout', [denied]);
	assert.equal(restored.requestId, denied.requestId);
	assert.equal(restored.fingerprint, denied.fingerprint);
	assert.equal(restored.checkoutId, committedId);
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${denied.requestId}'`), '1');
	await call(page, 'readCheckout', [restored]);
	// A failed cart read after registration retains the active registered pointer.
	const registered = await call<CheckoutSnapshot>(page, 'confirmCheckout', [restored]);
	await page.evaluate(() => { const old = Storage.prototype.getItem; window.restoreRead = () => Storage.prototype.getItem = old;
		Storage.prototype.getItem = function(key) { if (this === localStorage && key === 'ampoteket:cart') throw new DOMException('Denied', 'SecurityError'); return old.call(this, key); }; });
	await fails(page, 'finishRegistration', [restored, registered]);
	assert.equal((await call<ActiveAttempt>(page, 'readActiveAttempt')).state, 'registered');
	await page.evaluate(() => window.restoreRead());
	await call(page, 'finishRegistration', [restored, registered]);
	assert.equal(await call(page, 'readActiveAttempt'), null);
	assert.equal(await page.evaluate(() => localStorage.getItem('ampoteket:cart')), '[]');
	assert.equal((await context.cookies()).find(cookie => cookie.name === rootCookie.name)?.value, rootCookie.value);
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${restored.checkoutId}'`), '1');
	console.log('PASS: denied session payload, denied checkout-ID acknowledgement and denied cleanup retain safe recoverable state');
	// Simultaneous starts arbitrate one immutable attempt across tabs.
	await basket(page, freeProduct);
	const [claimA, claimB] = await Promise.all([
		call<ActiveAttempt>(page, 'startCheckout', ['first tab']),
		call<ActiveAttempt>(other, 'startCheckout', ['second tab'])
	]);
	assert.equal(claimA.requestId, claimB.requestId);
	const owner = await page.evaluate((id) => sessionStorage.getItem('ampoteket:prepare:' + id) !== null, claimA.requestId) ? page : other;
	const claimed = await call<ActiveAttempt>(owner, 'prepareCheckout', [claimA]);
	await page.goto(`${origin}/en/checkout/${claimed.checkoutId}`);
	await page.getByRole('button', { name: 'Change cart', exact: true }).click();
	await page.getByRole('button', { name: 'Nothing paid or taken, change cart', exact: true }).click();
	await expect(page.getByText('You can change your cart now.', { exact: true })).toBeVisible();
	await probe(page); assert.equal(await call(page, 'readActiveAttempt'), null);
	await page.getByRole('button', { name: 'Continue this purchase', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Complete purchase', exact: true })).toBeVisible();
	await complete(page, claimed);
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${claimed.requestId}'`), '1');
	console.log('PASS: simultaneous attempt claims converge; explicit unpaid/uncollected set-aside and resumption preserve identity');
	// Persisted known ID still supports staff recovery after cookie eviction.
	const recovery = await begin(page);
	await call(page, 'readCheckout', [recovery]);
	await context.clearCookies({ name: '__Host-amp_checkout' });
	await page.goto(`${origin}/en/checkout/${recovery.checkoutId}`);
	await expect(page.getByRole('link', { name: 'Contact a volunteer', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
	assert.ok(!(await context.cookies()).some((cookie) => cookie.name === '__Host-amp_checkout'));
	await page.goto(`${origin}/en/contact`);
	await expect(page.getByText('Proof volunteer 5', { exact: true })).toBeVisible();
	await expect(page.getByText('Private directory draft', { exact: true })).toHaveCount(0);
	console.log('PASS: missing cookie offers original-reference assistance; public directory traverses capped pages without drafts');
	// Staff UI integration is kept in a focused module, sharing only this owned test lifecycle.
	await context.addCookies([rootCookie]); // Restore the original test credential, never mint a replacement.
	const { exerciseAdminHelp } = await import('./admin-help-proof');
	await exerciseAdminHelp({ context, origin, api: api.origin, publicKey, staffEmail, nonstaffEmail, password,
		checkoutId: recovery.checkoutId!, requestId: recovery.requestId, sql, inviteAuthUser, readAuthEmail });
	console.log('PASS: staff/nonstaff login, directory edits/stale forms, lost staff recovery, revocation, rendered invitation/password emails and Auth logout preserving guest credentials');
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${recovery.checkoutId}'`), '1');
	await probe(page); assert.equal((await call<ActiveAttempt>(page, 'readActiveAttempt')).requestId, recovery.requestId);
	await page.goto(`${origin}/en/cart`);
	await probe(page); await expect.poll(() => call<ActiveAttempt | null>(page, 'readActiveAttempt')).toBeNull();
	await expect(page.getByText('You have a purchase in progress', { exact: true })).toHaveCount(0);
	await page.goto(`${origin}/en/checkout/${recovery.checkoutId}`);
	await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible();
	await probe(page);
	// Real staff JWT and guest gateway overlap on the same natural sale identity.
	const overlap = await begin(page, freeProduct);
	await call(page, 'readCheckout', [overlap]);
	const login = await fetch(`${api.origin}/auth/v1/token?grant_type=password`, {
		method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: staffEmail, password })
	});
	assert.ok(login.ok);
	const { access_token: staffToken } = await login.json() as { access_token: string };
	secrets.push(staffToken);
	const recoveryRequest = { p_request_id: crypto.randomUUID(), p_checkout_id: overlap.checkoutId, p_reason: 'Disposable real JWT overlap proof' };
	const [guestResult, staffResult] = await Promise.all([
		call<CheckoutSnapshot>(page, 'confirmCheckout', [overlap]),
		fetch(`${api.origin}/rest/v1/rpc/amp_recover_checkout`, {
			method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(recoveryRequest)
		})
	]);
	assert.ok(staffResult.ok); assert.equal(guestResult.status, 'confirmed');
	assert.equal((await staffResult.json() as { checkout_id: string }).checkout_id, overlap.checkoutId);
	await call(page, 'finishRegistration', [overlap, guestResult]);
	assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${overlap.checkoutId}'`), '1');
	console.log('PASS: real staff recovery and guest confirmation converge on the same registered purchase');
	// Staff registration has no local storage event in the buyer's browser.
	// Reconcile on return/reconnect, and check remotely before leaving for Vipps.
	let openedVipps = false;
	await page.route('https://qr.vipps.no/**', route => { openedVipps = true; return route.abort('failed'); });
	for (const trigger of ['focus', 'online', 'payment']) {
		await probe(page);
		const remotelyRegistered = await begin(page);
		await page.goto(`${origin}/en/checkout/${remotelyRegistered.checkoutId}`);
		await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toBeVisible();
		const result = await fetch(`${api.origin}/rest/v1/rpc/amp_recover_checkout`, {
			method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ p_request_id: crypto.randomUUID(), p_checkout_id: remotelyRegistered.checkoutId, p_reason: 'Disposable buyer freshness proof' })
		});
		assert.ok(result.ok); await result.body?.cancel();
		if (trigger === 'payment') await page.getByRole('link', { name: 'Open Vipps', exact: true }).click();
		else await page.evaluate(event => window.dispatchEvent(new Event(event)), trigger);
		await expect(page.getByText('Purchase registered.', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Change cart', exact: true })).toHaveCount(0);
		await probe(page); await expect.poll(() => call<ActiveAttempt | null>(page, 'readActiveAttempt')).toBeNull();
		assert.equal(await sql(`SELECT count(*) FROM app.sales WHERE checkout_id='${remotelyRegistered.checkoutId}'`), '1');
	}
	await probe(page);
	const delayedPayment = await begin(page);
	await page.goto(`${origin}/en/checkout/${delayedPayment.checkoutId}`);
	await expect(page.getByRole('link', { name: 'Open Vipps', exact: true })).toBeVisible();
	let releasePaymentRead!: () => void, paymentReadHeld = false, paymentReadReleased = false;
	const paymentReadGate = new Promise<void>(resolve => { releasePaymentRead = resolve; });
	await page.route(`**/api/checkouts/${delayedPayment.checkoutId}`, async route => {
		const request = route.request();
		const response = await fetch(request.url(), {
			method: request.method(), headers: await request.allHeaders(), body: request.postData(), tls: { ca }, redirect: 'manual'
		});
		const body = await response.text(); paymentReadHeld = true;
		await paymentReadGate;
		await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }); paymentReadReleased = true;
	}, { times: 1 });
	await page.getByRole('link', { name: 'Open Vipps', exact: true }).click();
	await expect.poll(() => paymentReadHeld).toBe(true);
	await page.locator('.site-header').getByRole('link', { name: 'Parts catalog', exact: true }).click();
	await expect(page).toHaveURL(`${origin}/en/p`);
	releasePaymentRead();
	await expect.poll(() => paymentReadReleased).toBe(true);
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	assert.equal(page.url(), `${origin}/en/p`, 'A late payment read never navigates away from the next page');
	assert.equal(openedVipps, false, 'Registered or abandoned payment actions never open Vipps');
	await probe(page); await complete(page, delayedPayment);
	await page.unroute('https://qr.vipps.no/**');
	console.log('PASS: remote staff registration reconciles on focus/reconnect and before payment without replacing the original checkout');
	// Real method/origin/content/body limits, including error cache policy.
	for (const test of [
		{ method: 'GET', expected: 405 },
		{ method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' }, body: '{}', expected: 403 },
		{ method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}', expected: 415 },
		{ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(32769), expected: 413 }
	]) {
		const result = await fetch(`${origin}/api/checkouts/prepare`, { ...test, tls: { ca } });
		assert.equal(result.status, test.expected); assert.equal(result.headers.get('cache-control'), 'no-store');
	}
	await page.goto(`${origin}/en/contact`); await probe(page); await probe(other);
	// Both tabs begin with no cookie. Delay the second response until the first
	// tab has claimed its attempt, reproducing a late Set-Cookie replacement.
	await basket(page, freeProduct);
	await context.clearCookies({ name: '__Host-amp_checkout' });
	let initializing = 0;
	await context.route('**/api/checkouts/session', async (route) => {
		const position = ++initializing;
		const headers = await route.request().allHeaders();
		assert.ok(!headers.cookie, 'Both initial requests precede cookie creation');
		// Send both cookie-less requests now; delay only delivery of Set-Cookie.
		const response = await fetch(route.request().url(), {
			method: 'POST', headers, body: route.request().postData(), tls: { ca }, redirect: 'manual'
		});
		assert.equal(response.status, 200);
		const body = await response.text();
		if (position === 1) {
			await expect.poll(() => initializing).toBe(2);
		} else {
			await expect.poll(async () => (await call<ActiveAttempt | null>(page, 'readActiveAttempt'))?.requestId ?? null).not.toBeNull();
		}
		await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
	});
	const [initialA, initialB] = await Promise.all([
		call<ActiveAttempt>(page, 'startCheckout', ['']), call<ActiveAttempt>(other, 'startCheckout', [''])
	]);
	await context.unroute('**/api/checkouts/session');
	assert.equal(initialA.requestId, initialB.requestId);
	const currentSession = await post(page, '/api/checkouts/session', {});
	assert.notEqual(initialA.fingerprint, currentSession.body.fingerprint);
	const rejected = await post(page, '/api/checkouts/prepare', {
		request_id: initialA.requestId, fingerprint: initialA.fingerprint,
		items: initialA.cartLines, contact: null
	});
	assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'CHECKOUT_SESSION_CHANGED');
	assert.equal(await sql(`SELECT count(*) FROM app.checkouts WHERE request_id='${initialA.requestId}'`), '0');
	assert.equal(await call(page, 'canOpenPayment', [initialA]), false);
	console.log('PASS: competing first cookie initializations strand safely at the original reference before any checkout/payment');
	let limited = false;
	for (let i = 0; i < 25; i++) {
		const result = await post(page, '/api/checkouts/session', {});
		if (result.status === 429) { limited = true; break; }
		assert.equal(result.status, 200);
	}
	assert.ok(limited, 'Native initialization limiter rejects excess requests');
	for (const cookie of await context.cookies()) if (cookie.name === '__Host-amp_checkout') secrets.push(cookie.value);
	const logs = await Bun.file(`${directory}/worker.log`).text() + await Bun.file(`${directory}/worker-error.log`).text();
	for (const value of [...secrets, 'private-test-contact']) assert.ok(!logs.includes(value), 'Sensitive values absent from Worker logs');
	assert.deepEqual(errors, []);
	console.log('PASS: actual gateway origin/JSON/body/rate limits, no-store errors, no sensitive Worker logging');
	console.log('PASS: milestone 3 disposable browser/Worker acceptance; physical phone/Vipps and production mail/provider checks remain separate');
} catch (error) {
	const logs = await Bun.file(`${directory}/worker-error.log`).text();
	if (logs.trim()) console.error(safe(logs).replace(/[a-f0-9]{64}/g, '[redacted]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]').slice(-3000));
	// eslint-disable-next-line preserve-caught-error -- a cause would print the unredacted secrets.
	throw new Error(safe(error instanceof Error ? error.message : String(error))
		.replace(/[a-f0-9]{64}/g, '[redacted]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]'));
} finally { await close(); }
