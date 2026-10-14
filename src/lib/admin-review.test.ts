import { expect, test } from 'bun:test';
import { readNewProducts, readReviewPoint, reviewedThrough, reviewList, reviewSince, timestampMicros, writeReviewPoint, type NewProduct } from './admin-review';
import { auditActor, readProductCreations, type AuditEntry } from './admin-audit';
import { memory } from './test-storage';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const viewer = id(900); const other = id(901);
const product = (n: number, created_at: string): NewProduct => ({
	id: id(n), code: `RES-0000${n}`, name_nb: `Motstand ${n}`, name_en: `Resistor ${n}`, description: null, category_id: null, bin_id: null, location_note: null,
	unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '1', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: false,
	metadata_revision: '1', created_at
});
const creation = (n: number, actorId: string | null): AuditEntry => ({ id: String(100 + n), table: 'products', key: { id: id(n) }, action: 'INSERT', before: null, after: { id: id(n) }, actorId, role: 'authenticated', recordedAt: '2026-10-14T10:00:00Z' });

test('timestamps compare at microsecond precision across offsets', () => {
	expect(timestampMicros('2026-10-14T10:00:00.123457+00:00') > timestampMicros('2026-10-14T10:00:00.123456Z')).toBe(true);
	expect(timestampMicros('2026-10-14T12:00:00+02:00')).toBe(timestampMicros('2026-10-14T10:00:00.000Z'));
	expect(timestampMicros('2026-10-14T12:00:00.5+02')).toBe(timestampMicros('2026-10-14T10:00:00.500000Z'));
	expect(() => timestampMicros('yesterday')).toThrow();
});

test('the list is newest first, after the review point, without the viewer\'s own products', () => {
	const products = [
		product(1, '2026-10-14T09:00:00.000001+00:00'), // at the point: already reviewed
		product(2, '2026-10-14T09:00:00.000002+00:00'),
		product(3, '2026-10-14T11:00:00+00:00'), // the viewer's own
		product(4, '2026-10-14T10:00:00+00:00'), // no audit entry (truncated log): kept, creator unknown
		product(5, '2026-10-14T10:00:00+00:00')
	];
	const creations = [creation(1, other), creation(2, other), creation(3, viewer), creation(5, null)];
	const list = reviewList(products, creations, '2026-10-14T09:00:00.000001Z', viewer);
	expect(list.map(item => item.product.code)).toEqual(['RES-00004', 'RES-00005', 'RES-00002']);
	expect(list[0].creation).toBeNull();
	expect(list[2].creation?.actorId).toBe(other);
	// Without the audit the viewer's own products stay, rather than the list looking empty.
	expect(reviewList(products, null, '2026-10-14T09:00:00.000001Z', viewer).map(item => item.product.code)).toEqual(['RES-00003', 'RES-00004', 'RES-00005', 'RES-00002']);
	expect(reviewedThrough(list)).toBe('2026-10-14T10:00:00+00:00');
	expect(reviewedThrough([])).toBeNull();
	// Marking reviewed through the newest listed product empties the list but keeps anything later.
	expect(reviewList(products, creations, reviewedThrough(list)!, viewer)).toEqual([]);
	expect(reviewList([...products, product(6, '2026-10-14T10:00:00.000001+00:00')], creations, reviewedThrough(list)!, viewer).map(item => item.product.code)).toEqual(['RES-00006']);
});

test('the review point is stored per staff user and falls back to the last 14 days', () => {
	const storage = memory();
	expect(readReviewPoint('a', storage)).toBeNull();
	writeReviewPoint('a', '2026-10-14T10:00:00.123456+00:00', storage);
	expect(readReviewPoint('a', storage)).toBe('2026-10-14T10:00:00.123456+00:00');
	expect(readReviewPoint('b', storage)).toBeNull();
	expect(readReviewPoint(undefined, storage)).toBeNull();
	expect(() => writeReviewPoint('a', 'soon', storage)).toThrow();
	storage.setItem('ampoteket:draft:v1:b:product-review', JSON.stringify({ since: 'garbage' }));
	expect(readReviewPoint('b', storage)).toBeNull();
	expect(reviewSince(null, Date.parse('2026-10-15T00:00:00Z'))).toBe('2026-10-01T00:00:00.000Z');
	expect(reviewSince('2026-10-14T10:00:00+00:00')).toBe('2026-10-14T10:00:00+00:00');
});

const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-jwt', userId: viewer };

test('new products and their creations are read after the review point', async () => {
	const urls: URL[] = [];
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input)); urls.push(url);
		if (url.pathname.endsWith('amp_products')) return new Response(JSON.stringify(url.searchParams.has('and') ? [] : [product(1, '2026-10-14T10:00:00.5+00:00')]));
		const rows = url.searchParams.has('id') ? [] : [{ id: '7', table_name: 'products', row_key: { id: id(1) }, action: 'INSERT', before_data: null, after_data: { id: id(1) }, actor_id: other, database_role: 'authenticated', recorded_at: '2026-10-14T10:00:00.5+00:00' }];
		return new Response(JSON.stringify(rows));
	};
	const since = '2026-10-14T09:00:00.123456+00:00';
	const products = await readNewProducts(session, since, fetcher);
	expect(products[0].created_at).toBe('2026-10-14T10:00:00.5+00:00');
	expect(urls[0].searchParams.get('created_at')).toBe(`gt.${since}`);
	expect(urls[0].searchParams.get('select')).toContain('created_at');
	const creations = await readProductCreations(session, since, fetcher);
	expect(creations.map(entry => entry.actorId)).toEqual([other]);
	const auditUrl = urls.find(url => url.pathname.endsWith('amp_audit_log'))!;
	expect(Object.fromEntries(['table_name', 'action', 'recorded_at'].map(key => [key, auditUrl.searchParams.get(key)]))).toEqual({ table_name: 'eq.products', action: 'eq.INSERT', recorded_at: `gte.${since}` });
	expect(auditActor(creations[0], 'en', { staff_members: { [other]: { display_name: 'Ada' } } })).toBe('Ada');
	expect(auditActor(creations[0], 'en', {})).toBe('Unknown admin');
});
