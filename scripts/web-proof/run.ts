import { firefox, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { proofEnvironment } from './harness';

const { directory, origin, api, publicKey, serviceKey, password, safe, sql, createUser, startWorker } = await proofEnvironment();
const staffId = await createUser('staff@example.test');
await createUser('nonstaff@example.test');
const loginProbe = await fetch(new URL('/auth/v1/token?grant_type=password', api), {
	method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${publicKey}`, 'Content-Type': 'application/json' },
	body: JSON.stringify({ email: 'staff@example.test', password })
});
if (!loginProbe.ok) {
	const raw = await loginProbe.text();
	const safe = [serviceKey, publicKey, password].reduce((text, secret) => text.replaceAll(secret, '[redacted]'), raw);
	throw new Error(`Local Auth preflight failed (${loginProbe.status}): ${safe.slice(0, 500)}`);
}
await loginProbe.body?.cancel();
const signupProbe = await fetch(new URL('/auth/v1/signup', api), {
	method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' },
	body: JSON.stringify({ email: 'uninvited@example.test', password })
});
assert.equal(signupProbe.ok, false);
assert.equal((await signupProbe.json() as { error_code: string }).error_code, 'signup_disabled');
await sql(await Bun.file('scripts/web-proof/fixtures.sql').text(), ['-v', `staff_id=${staffId}`]);
await sql("NOTIFY pgrst, 'reload schema';");

const bundle = await Bun.build({ entrypoints: ['scripts/web-proof/browser.ts'], outdir: `${directory}/assets`, target: 'browser' });
if (!bundle.success) throw new Error('Browser probe build failed');
await writeFile(`${directory}/assets/index.html`, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Disposable boundary proof</title><script type="module" src="/browser.js"></script></html>');
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context, {
	name: 'ampoteket-disposable-proof', main: resolve('scripts/web-proof/worker.ts'), compatibility_date: '2026-09-18',
	assets: { directory: `${directory}/assets`, binding: 'ASSETS', run_worker_first: true },
	vars: { API_URL: api.origin, PUBLISHABLE_KEY: publicKey }, workers_dev: false
});
try {
	await ready('/proof/config');
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const page = await context.newPage();
	await page.goto(origin);
	await page.waitForFunction(() => 'proof' in window);
	// Probe objects contain public data only; tokens stay inside the Auth client.
	const call = (method: string, args: unknown[] = []) => page.evaluate(async ({ method, args }) => {
		const proof = (window as unknown as { proof: Record<string, (...args: unknown[]) => Promise<unknown>> }).proof;
		return proof[method](...args);
	}, { method, args });
	assert.equal(await call('login', ['nonstaff@example.test', password]), null);
	assert.deepEqual(await call('staffProducts'), []);
	assert.equal(await call('logout'), true);
	assert.equal((await call('login', ['staff@example.test', password]) as { authUserId: string }).authUserId, staffId);
	assert.equal(await call('refresh'), true);
	await page.reload();
	await page.waitForFunction(() => 'proof' in window);
	assert.equal((await call('membership') as { authUserId: string }).authUserId, staffId);
	console.log('PASS: real password sign-in with public signup disabled, nonstaff denial, token refresh and reload');

	const firstPage = await call('catalogPage') as { products: unknown[]; complete: boolean };
	assert.equal(firstPage.products.length, 2);
	assert.equal(firstPage.complete, false);
	const workerPage = await page.evaluate(async () => (await fetch('/proof/catalog')).json());
	assert.equal(workerPage.products[0].sale_unit_price_nok, '999999999998.999999');
	assert.equal(workerPage.products.length, 2);
	const products = await call('catalog') as Array<{ code: string; sale_unit_price_nok: string; attributes: { capacitance?: { value: string } } }>;
	assert.equal(products.length, 3); // PostgREST is deliberately capped to two rows.
	assert.equal(products[0].sale_unit_price_nok, '999999999998.999999');
	assert.equal(products[0].attributes.capacitance?.value, '0.000000000005');
	assert.equal((await call('product', ['RES-00001']) as { code: string }).code, 'RES-00001');
	const updated = await call('updatePrice', ['73000000-0000-4000-8000-000000000001', '1', '999999999998.999998']) as Array<{ sale_unit_price_nok: string; metadata_revision: string }>;
	assert.equal(updated[0].sale_unit_price_nok, '999999999998.999998');
	assert.equal(updated[0].metadata_revision, '2');
	const verified = await sql("SELECT sale_unit_price_nok::text FROM app.products WHERE code='CAP-00001';", ['-t', '-A']);
	assert.equal(verified, '999999999998.999998');
	console.log('PASS: capped browser/Worker catalog reads, complete traversal, direct lookup and exact browser → database price round trip');

	const post = (path: string, body: unknown = {}) => page.evaluate(async ({ path, body }) => {
		const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		return { status: response.status, cache: response.headers.get('Cache-Control'), body: await response.json() };
	}, { path, body });
	const initialized = await post('/proof/session');
	assert.equal(initialized.status, 200);
	assert.equal(initialized.cache, 'no-store');
	const fingerprint = initialized.body.fingerprint;
	assert.match(fingerprint, /^[a-f0-9]{64}$/);
	const cookies = await context.cookies();
	const root = cookies.find((cookie) => cookie.name === '__Host-amp_checkout')!;
	assert.ok(root.secure && root.httpOnly && root.sameSite === 'Lax' && root.path === '/');
	assert.equal(await page.evaluate(() => document.cookie.includes('__Host-amp_checkout')), false);
	assert.equal(JSON.stringify(initialized).includes(root.value), false);
	assert.equal((await post('/proof/session')).body.fingerprint, fingerprint);
	const requestId = crypto.randomUUID();
	assert.equal((await post('/proof/binding', { requestId, fingerprint })).status, 200);
	assert.equal((await post('/proof/binding', { requestId, fingerprint: '0'.repeat(64) })).status, 409);
	await page.reload();
	await page.waitForFunction(() => 'proof' in window);
	assert.equal((await post('/proof/binding', { requestId, fingerprint })).status, 200);

	await sql("UPDATE app.staff_members SET is_active=false WHERE auth_user_id=:'staff_id';", ['-v', `staff_id=${staffId}`]);
	assert.equal(await call('membership'), null);
	assert.deepEqual(await call('staffProducts'), []);
	assert.deepEqual(await call('updatePrice', ['73000000-0000-4000-8000-000000000001', '2', '1']), []);
	assert.equal(await call('logout'), true);
	assert.equal((await post('/proof/binding', { requestId, fingerprint })).status, 200);
	assert.ok((await context.cookies()).find((cookie) => cookie.name === root.name)?.value === root.value,
		'Auth logout preserves the checkout root');
	await context.clearCookies();
	assert.equal((await post('/proof/binding', { requestId, fingerprint })).status, 409);
	assert.equal((await context.cookies()).length, 0);
	console.log('PASS: immediate membership revocation; Secure/HttpOnly cookie survives Auth logout; missing/changed credentials fail closed');
	console.log('PASS: local Auth/HTTPS boundary proof (test fixture, not operational checkout acceptance)');
} catch (error) {
	const raw = await Bun.file(`${directory}/worker-error.log`).text() + await Bun.file(`${directory}/worker.log`).text();
	const redacted = safe(raw);
	if (redacted.trim()) console.error(redacted.slice(-4000));
	throw error;
} finally {
	await close();
}
