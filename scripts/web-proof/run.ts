import { firefox, type BrowserContext } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { post, proofEnvironment } from './harness';

const { directory, origin, convexUrl, password, safe, fixtures, createStaff, createUser, startWorker } = await proofEnvironment();
const { authUserId: staffId } = await createStaff('staff@example.test');
await createUser('nonstaff@example.test');
// Proof inventory sits in its own cabinet, apart from the seeded wall.
const cabinet = '74000000-0000-4000-8000-000000000001', bin = '75000000-0000-4000-8000-000000000001';
await fixtures.insert('cabinets', [{ id: cabinet, code: 'PROOF-CAB', outer_row: 3, outer_col: 1, inner_rows: 2, inner_cols: 2, label: null, is_archived: false }]);
await fixtures.insert('bins', [{ id: bin, code: 'PROOF-BIN', cabinet_id: cabinet, inner_row: 1, inner_col: 1, row_span: 1, col_span: 1, label: null, is_archived: false }]);
const now = new Date().toISOString().replace('Z', '000Z');
const product = (n: number, code: string, name_nb: string, name_en: string, price: string) => ({
	id: `73000000-0000-4000-8000-00000000000${n}`, code, name_nb, name_en, description: null, category_id: null, bin_id: bin, location_note: null,
	unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: price, minimum_stock: '0', datasheet_url: null, purchase_url: null,
	is_active: true, metadata_revision: 1, created_at: now, updated_at: now });
await fixtures.insert('products', [product(1, 'CAP-00001', 'Bevis-kondensator', 'Proof capacitor', '999999999998.999999'),
	product(2, 'LED-00001', 'Bevis-LED', 'Proof LED', '0'), product(3, 'RES-00001', 'Bevis-motstand', 'Proof resistor', '0.005')]);
await fixtures.insert('attribute_definitions', [{ id: '76000000-0000-4000-8000-000000000001', code: 'capacitance', label: 'Capacitance', value_type: 'number', canonical_unit: 'F' }]);
await fixtures.insert('product_attributes', [{ product_id: '73000000-0000-4000-8000-000000000001', attribute_id: '76000000-0000-4000-8000-000000000001',
	number_value: '0.000000000005', number_max: null, text_value: null, boolean_value: null }]);

const bundle = await Bun.build({ entrypoints: ['scripts/web-proof/browser.ts'], outdir: `${directory}/assets`, target: 'browser' });
if (!bundle.success) throw new Error('Browser probe build failed');
await writeFile(`${directory}/assets/index.html`, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Disposable boundary proof</title><script type="module" src="/browser.js"></script></html>');
let context: BrowserContext | undefined;
const { ready, close } = await startWorker(() => context, {
	name: 'ampoteket-disposable-proof', main: resolve('scripts/web-proof/worker.ts'), compatibility_date: '2026-09-18',
	assets: { directory: `${directory}/assets`, binding: 'ASSETS', run_worker_first: true },
	vars: { CONVEX_URL: convexUrl }, workers_dev: false
});
try {
	await ready('/proof/config');
	context = await firefox.launchPersistentContext(`${directory}/profile`, { headless: true, ignoreHTTPSErrors: false });
	const page = await context.newPage();
	await page.goto(origin);
	await page.waitForFunction(() => 'proof' in window);
	// Probe objects contain public data only; tokens stay inside the Auth session.
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
	console.log('PASS: real password sign-in with sign-up impossible, nonstaff denial, token refresh and reload');

	const firstPage = await call('catalogPage', [2]) as { products: unknown[]; complete: boolean };
	assert.equal(firstPage.products.length, 2);
	assert.equal(firstPage.complete, false);
	const workerPage = await page.evaluate(async () => (await fetch('/proof/catalog')).json());
	assert.equal(workerPage.products.length, 2);
	assert.ok(workerPage.products.some((p: { sale_unit_price_nok: string }) => p.sale_unit_price_nok === '999999999998.999999'));
	const products = await call('catalog') as Array<{ code: string; sale_unit_price_nok: string; attributes: { capacitance?: { value: string } } }>;
	assert.equal(products.length, 3);
	const capacitor = products.find((p) => p.code === 'CAP-00001')!;
	assert.equal(capacitor.sale_unit_price_nok, '999999999998.999999');
	assert.equal(capacitor.attributes.capacitance?.value, '0.000000000005');
	assert.equal((await call('product', ['RES-00001']) as { code: string }).code, 'RES-00001');
	const updated = await call('updatePrice', ['73000000-0000-4000-8000-000000000001', '1', '999999999998.999998']) as Array<{ sale_unit_price_nok: string; metadata_revision: string }>;
	assert.equal(updated[0].sale_unit_price_nok, '999999999998.999998');
	assert.equal(updated[0].metadata_revision, '2');
	const [stored] = await fixtures.rows<{ sale_unit_price_nok: string }>('products', { code: 'CAP-00001' });
	assert.equal(stored.sale_unit_price_nok, '999999999998.999998');
	console.log('PASS: browser and Worker catalog reads, complete traversal, direct lookup and exact browser → database price round trip');

	const initialized = await post(page, '/proof/session');
	assert.equal(initialized.status, 200);
	assert.equal(initialized.cache, 'no-store');
	const fingerprint = initialized.body.fingerprint;
	assert.match(fingerprint, /^[a-f0-9]{64}$/);
	const cookies = await context.cookies();
	const root = cookies.find((cookie) => cookie.name === '__Host-amp_checkout')!;
	assert.ok(root.secure && root.httpOnly && root.sameSite === 'Lax' && root.path === '/');
	assert.equal(await page.evaluate(() => document.cookie.includes('__Host-amp_checkout')), false);
	assert.equal(JSON.stringify(initialized).includes(root.value), false);
	assert.equal((await post(page, '/proof/session')).body.fingerprint, fingerprint);
	const requestId = crypto.randomUUID();
	assert.equal((await post(page, '/proof/binding', { requestId, fingerprint })).status, 200);
	assert.equal((await post(page, '/proof/binding', { requestId, fingerprint: '0'.repeat(64) })).status, 409);
	await page.reload();
	await page.waitForFunction(() => 'proof' in window);
	assert.equal((await post(page, '/proof/binding', { requestId, fingerprint })).status, 200);

	await fixtures.patch('staff_members', { auth_user_id: staffId }, { is_active: false });
	assert.equal(await call('membership'), null);
	assert.deepEqual(await call('staffProducts'), []);
	assert.deepEqual(await call('updatePrice', ['73000000-0000-4000-8000-000000000001', '2', '1']), []);
	assert.equal(await call('logout'), true);
	assert.equal((await post(page, '/proof/binding', { requestId, fingerprint })).status, 200);
	assert.ok((await context.cookies()).find((cookie) => cookie.name === root.name)?.value === root.value,
		'Auth logout preserves the checkout root');
	await context.clearCookies();
	assert.equal((await post(page, '/proof/binding', { requestId, fingerprint })).status, 409);
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
