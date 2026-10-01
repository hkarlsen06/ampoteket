// Run only through test-api.sh: loopback HTTP and synthetic JWTs.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { isRecord, parseApiJson, requestApiJson } from '../src/lib/api';

const origin = process.env.AMP_API_TEST_ORIGIN;
const secret = process.env.AMP_API_TEST_JWT_SECRET;
assert(origin && /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin));
assert(secret === 'ampoteket-disposable-api-test-key-never-use-in-production');
const productId = '73000000-0000-4000-8000-000000000001';
const cableId = '73000000-0000-4000-8000-000000000002';
const staffId = '71000000-0000-4000-8000-000000000001';
const nonstaffId = '71000000-0000-4000-8000-000000000003';

function jwt(role: string, sub?: string, key = secret!, expires = Math.floor(Date.now() / 1000) + 300) {
	const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
	const claims = Buffer.from(JSON.stringify({ role, sub, exp: expires })).toString('base64url');
	const body = `${header}.${claims}`;
	return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
const staff = jwt('authenticated', staffId);
const nonstaff = jwt('authenticated', nonstaffId);
const disabled = jwt('authenticated', '71000000-0000-4000-8000-000000000002');
const service = jwt('service_role');
const anon = jwt('anon');

const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	assert.equal(url.origin, 'http://localhost');
	return fetch(new URL(url.pathname + url.search, origin), init);
};
function options(token?: string, method = 'GET', body?: unknown): RequestInit {
	return { method, headers: {
		'Content-Type': 'application/json', Prefer: 'return=representation',
		...(token ? { Authorization: `Bearer ${token}` } : {})
	}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function read(path: string, token?: string, method = 'GET', body?: unknown) {
	return requestApiJson(`http://localhost/${path}`, options(token, method, body), fetcher);
}
function record(value: unknown): Record<string, unknown> {
	assert(isRecord(value));
	return value;
}
function rows(value: unknown): Record<string, unknown>[] {
	assert(Array.isArray(value));
	return value.map(record);
}
async function denied(path: string, token: string | undefined, status: number, method = 'GET', body?: unknown) {
	const response = await fetcher(`http://localhost/${path}`, options(token, method, body));
	assert.equal(response.status, status, `Unexpected authorization status: ${path}`);
	await response.text();
}

// Observe actual PostgREST's native numeric JSON, then the mandatory raw parser.
const rawResponse = await fetcher(`http://localhost/amp_products?id=eq.${productId}`, options(staff));
assert.equal(rawResponse.status, 200);
const raw = await rawResponse.text();
assert(raw.includes('"sale_unit_price_nok":999999999998.999999'));
const product = rows(parseApiJson(raw))[0];
assert.equal(product.sale_unit_price_nok, '999999999998.999999');
assert.equal(typeof product.metadata_revision, 'string');
const edited = rows(await read(`amp_products?id=eq.${productId}&metadata_revision=eq.${product.metadata_revision}`,
	staff, 'PATCH', { sale_unit_price_nok: product.sale_unit_price_nok }));
assert.equal(edited.length, 1);
assert.equal(edited[0].sale_unit_price_nok, '999999999998.999999');
const stale = rows(await read(`amp_products?id=eq.${productId}&metadata_revision=eq.${product.metadata_revision}`,
	staff, 'PATCH', { sale_unit_price_nok: product.sale_unit_price_nok }));
assert.equal(stale.length, 0);
const inventory = rows(await read(`amp_inventory?product_id=eq.${productId}`, staff))[0];
assert.equal(inventory.quantity, '1103');
assert(BigInt(inventory.revision as string) > 9007199254740991n);
const firstMovement = rows(await read('amp_inventory_movements?order=id.asc&limit=1', staff))[0];
assert.equal(firstMovement.id, '9007199254740993');
const audit = rows(await read('amp_audit_log?table_name=eq.products&order=id.desc&limit=1', staff))[0];
assert(BigInt(audit.id as string) > 9007199254740991n);
assert.equal(record(audit.after_data).sale_unit_price_nok, '999999999998.999999');
console.log('PASS: actual HTTP preserves native decimals, bigint revisions, audit JSON and metadata edits');

// The actual server row cap is 37, even though each SQL RPC asks for 200.
const codes = new Set<string>();
let after: string | null = null;
let catalogPages = 0;
while (true) {
	const page = rows(await read('rpc/amp_catalog', anon, 'POST', {
		p_after_code: after, p_limit: 200,
		p_cabinet_ids: ['74000000-0000-4000-8000-000000000001'],
		p_bin_ids: ['75000000-0000-4000-8000-000000000001']
	}));
	assert(page.length <= 37);
	if (page.length === 0) break;
	for (const item of page) {
		assert.equal(typeof item.code, 'string');
		assert(!codes.has(item.code as string));
		codes.add(item.code as string);
	}
	assert(page.at(-1)!.code !== after);
	after = page.at(-1)!.code as string;
	assert(++catalogPages < 100);
}
assert.equal(codes.size, 1105);
for (let i = 1; i <= 1103; i++) assert(codes.has(`PAGE-${String(i).padStart(4, '0')}`));
const lookup = rows(await read('rpc/amp_catalog', anon, 'POST', { p_code: 'TEST-R', p_after_code: 'ZZZZ' }));
assert.equal(lookup.length, 1);
assert.equal(lookup[0].sale_unit_price_nok, '999999999998.999999');
assert.equal(record(record(lookup[0].attributes).test_resistance).value, '999999999998.999999');
for (const field of ['p_cabinet_ids', 'p_bin_ids']) {
	for (const value of [null, [null], ['00000000-0000-0000-0000-000000000000']]) {
		const response = await fetcher('http://localhost/rpc/amp_catalog', options(anon, 'POST', {
			[field]: value, p_q: 'not-present'
		}));
		assert.equal(response.status, 400);
		assert.equal(record(await response.json()).message, 'INVALID_CATALOG_FILTER');
	}
}
const movementIds = new Set<string>();
let lastId = '0';
while (true) {
	const page = rows(await read(`amp_inventory_movements?order=id.asc&limit=200&id=gt.${lastId}`, staff));
	assert(page.length <= 37);
	if (page.length === 0) break;
	for (const item of page) {
		assert.equal(typeof item.id, 'string');
		assert(BigInt(item.id as string) > BigInt(lastId));
		assert(!movementIds.has(item.id as string));
		movementIds.add(item.id as string);
		lastId = item.id as string;
	}
	assert(movementIds.size <= 1103);
}
assert.equal(movementIds.size, 1103);
console.log('PASS: HTTP keyset traversal reads all 1105 catalog products with overlapping cabinet/drawer filters and 1103 movements under a 37-row API cap; malformed/unknown locations fail on empty searches');

for (const token of [undefined, anon, staff, nonstaff, service]) {
	const topology = record(await read('rpc/amp_shelf_map', token));
	const cabinets = rows(topology.cabinets);
	const bins = rows(topology.bins);
	assert.equal(cabinets.length, 40);
	assert.equal(bins.length, 47);
	assert(bins.some((bin) => bin.code === 'EMPTY-BIN-2')); // inactive-only bin
	assert(bins.some((bin) => bin.code === 'EMPTY-BIN-3'));
	assert(!bins.some((bin) => bin.code === 'EMPTY-BIN-48'));
	assert(!cabinets.some((cabinet) => cabinet.code === 'EMPTY-CAB-40'));
	assert(bins.every((bin) => !('quantity' in bin) && !('created_by' in bin)));
}
console.log('PASS: complete public topology exceeds the API row cap and excludes retired storage');

const contactIds = new Set<string>();
let contactCursor: { p_after_order: string; p_after_id: string } | undefined;
while (true) {
	const page = rows(await read('rpc/amp_help_directory', anon, 'POST', { ...contactCursor, p_limit: 100 }));
	assert(page.length <= 37);
	if (page.length === 0) break;
	for (const contact of page) {
		assert.deepEqual(Object.keys(contact).sort(), ['contact_url', 'discord', 'display_name', 'display_order', 'email', 'id', 'phone', 'responsibility']);
		assert(!contactIds.has(contact.id as string));
		contactIds.add(contact.id as string);
	}
	const last = page.at(-1)!;
	contactCursor = { p_after_order: last.display_order as string, p_after_id: last.id as string };
	assert(contactIds.size <= 95);
}
// 83 fixtures plus the 12 volunteers the migration publishes.
assert.equal(contactIds.size, 95);
assert.deepEqual(await read('amp_help_contacts', nonstaff), []);
assert.deepEqual(await read('amp_help_contacts', disabled), []);
const contactBody = { id: randomUUID(), display_name: 'HTTP volunteer', email: 'http@example.invalid', is_published: false };
for (const [token, status] of [[undefined, 401], [anon, 401], [nonstaff, 403], [disabled, 403], [service, 403]] as const) {
	await denied('amp_help_contacts', token, status, 'POST', contactBody);
}
const draft = rows(await read('amp_help_contacts', staff, 'POST', contactBody))[0];
assert.equal(draft.edit_revision, '1');
const publishPath = `amp_help_contacts?id=eq.${draft.id}&edit_revision=eq.${draft.edit_revision}`;
const published = rows(await read(publishPath, staff, 'PATCH', { is_published: true, edit_revision: draft.edit_revision }))[0];
assert.equal(published.edit_revision, '2');
assert.deepEqual(await read(publishPath, staff, 'PATCH', { is_published: false, edit_revision: draft.edit_revision }), []);
await denied(`amp_help_contacts?id=eq.${draft.id}`, staff, 400, 'PATCH', { contact_url: 'javascript:alert(1)' });
const contactAudit = rows(await read('amp_audit_log?table_name=eq.help_contacts&order=id.desc&limit=1', staff))[0];
assert.equal(contactAudit.actor_id, '72000000-0000-4000-8000-000000000001');
assert.equal(record(contactAudit.after_data).edit_revision, '2');
const unpublished = rows(await read(`amp_help_contacts?id=eq.${draft.id}&edit_revision=eq.2`, staff, 'PATCH', { is_published: false, edit_revision: '2' }))[0];
assert.equal(unpublished.is_published, false);
console.log('PASS: directory HTTP pagination, safe projection, staff-only publication, stale edits, URL validation and audit attribution');

await denied('amp_products', undefined, 401);
await denied('amp_products', anon, 401);
assert.deepEqual(await read('amp_products', nonstaff), []);
assert.deepEqual(await read('amp_products', disabled), []);
await denied('amp_products', service, 403);
const manualBody = { p_request_id: randomUUID(), p_items: [{ product_id: productId, quantity_delta: '1' }], p_reason: 'Unauthorized fixture' };
await denied('rpc/amp_adjust_stock', undefined, 401, 'POST', manualBody);
await denied('rpc/amp_adjust_stock', nonstaff, 403, 'POST', manualBody);
await denied('rpc/amp_adjust_stock', disabled, 403, 'POST', manualBody);
await denied('rpc/amp_adjust_stock', service, 403, 'POST', manualBody);
await denied('amp_checkouts?select=token_digest', staff, 400);
const hiddenSchema = await fetcher('http://localhost/products', {
	headers: { Authorization: `Bearer ${staff}`, 'Accept-Profile': 'app' }
});
assert.equal(hiddenSchema.status, 406);
await hiddenSchema.text();
await denied('rpc/amp_shelf_map', jwt('authenticated', staffId, 'wrong-signing-key-that-is-long-enough'), 401);
await denied('rpc/amp_shelf_map', jwt('authenticated', staffId, secret, 1), 401);

const checkoutToken = 'ab'.repeat(32);
const prepareBody = { p_request_id: randomUUID(), p_token: checkoutToken, p_items: [{ product_id: cableId, quantity: '0.1' }] };
await denied('rpc/amp_prepare_checkout', undefined, 401, 'POST', prepareBody);
await denied('rpc/amp_prepare_checkout', staff, 403, 'POST', prepareBody);
await denied('rpc/amp_prepare_checkout', nonstaff, 403, 'POST', prepareBody);
const prepared = record(await read('rpc/amp_prepare_checkout', service, 'POST', prepareBody));
const recoveredReference = rows(await read(`amp_checkouts?request_id=eq.${prepareBody.p_request_id}`, staff));
assert.equal(recoveredReference.length, 1);
assert.equal(recoveredReference[0].id, prepared.checkout_id);
assert.equal(recoveredReference[0].request_id, prepareBody.p_request_id);
assert.deepEqual(await read(`amp_checkouts?request_id=eq.${prepareBody.p_request_id}`, nonstaff), []);
const checkoutBody = { p_checkout_id: prepared.checkout_id, p_token: checkoutToken };
await denied('rpc/amp_get_checkout', staff, 403, 'POST', checkoutBody);
await denied('rpc/amp_get_checkout', service, 403, 'POST', { ...checkoutBody, p_token: 'cd'.repeat(32) });
const checkout = record(await read('rpc/amp_get_checkout', service, 'POST', checkoutBody));
assert.equal(checkout.total_nok, '1.20');
assert.equal(checkout.status, 'unconfirmed');
const emptyStatistics = record(await read('rpc/amp_admin_statistics', staff, 'POST', {}));
assert.deepEqual(record(emptyStatistics.summary), { sale_count: '0', total_nok: '0.00', quantity: null });
assert.equal(rows(emptyStatistics.days).length, 30);
assert.equal(record(emptyStatistics.overview).attention_count, '1104');
assert.equal(rows(record(emptyStatistics.overview).attention).length, 8);
for (const [token, status] of [[undefined, 401], [anon, 401], [nonstaff, 403], [disabled, 403], [service, 403]] as const) {
	await denied('rpc/amp_admin_statistics', token, status, 'POST', {});
}
const confirmed = record(await read('rpc/amp_confirm_checkout', service, 'POST', checkoutBody));
const duplicate = record(await read('rpc/amp_confirm_checkout', service, 'POST', checkoutBody));
assert.deepEqual(duplicate, confirmed);
assert.equal(confirmed.status, 'confirmed');
assert.equal(rows(await read(`amp_inventory?product_id=eq.${cableId}`, staff))[0].quantity, '-0.1');
const statistics = record(await read('rpc/amp_admin_statistics', staff, 'POST', {}));
assert.deepEqual(record(statistics.summary), { sale_count: '1', total_nok: '1.20', quantity: null });
assert.deepEqual(rows(statistics.days).at(-1), {
	date: statistics.end_date, sale_count: '1', total_nok: '1.20', quantity: null
});
const productStatistics = record(await read('rpc/amp_admin_statistics', staff, 'POST', { p_product_id: cableId }));
assert.deepEqual(record(productStatistics.summary), { sale_count: '1', total_nok: '1.20', quantity: '0.1' });
assert.equal(productStatistics.overview, null);
assert.deepEqual(productStatistics.products, []);
await denied('rpc/amp_admin_statistics', staff, 400, 'POST', { p_product_id: randomUUID() });
console.log('PASS: staff-only HTTP statistics exclude preparations, preserve exact registered totals and restrict product scope');
console.log('PASS: real JWT signature checks, staff/non-staff/disabled/service ACLs, staff request-ID recovery lookup, hidden app schema and idempotent guest confirmation');
