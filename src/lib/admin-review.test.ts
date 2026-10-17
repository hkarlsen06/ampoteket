import { expect, test } from 'bun:test';
import { readNewProducts, readReviewPoint, reviewedThrough, reviewList, reviewSince, timestampMicros, writeReviewPoint, type NewProduct } from './admin-review';
import { auditActor, readProductCreations, type AuditEntry } from './admin-audit';
import { getFunctionName } from 'convex/server';
import type { ConvexCaller } from './convex';
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

type Call = { name: string; args: Record<string, unknown> };
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>, calls: Call[]): ConvexCaller {
	const call = async (fn: never, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { query: call, mutation: call, action: call } as unknown as ConvexCaller;
}

test('new products and their creations are read after the review point', async () => {
	const calls: Call[] = [];
	const since = '2026-10-14T09:00:00.123456+00:00';
	const client = stub({
		'products:createdSince': () => [product(1, '2026-10-14T10:00:00.500000Z')],
		'auditLog:productCreations': () => ({
			entries: [{ id: '7', table_name: 'products', row_key: { id: id(1) }, action: 'INSERT', before_data: null, after_data: { id: id(1) }, actor_id: other, database_role: 'authenticated', recorded_at: '2026-10-14T10:00:00.500000Z' }],
			references: { staff_members: { [other]: { id: other, display_name: 'Ada' } } }
		})
	}, calls);
	const session = { client, userId: viewer };
	const products = await readNewProducts(session, since);
	expect(products[0].created_at).toBe('2026-10-14T10:00:00.500000Z');
	expect(calls[0]).toEqual({ name: 'products:createdSince', args: { since } });
	const creations = await readProductCreations(session, since);
	expect(calls[1]).toEqual({ name: 'auditLog:productCreations', args: { since } });
	expect(creations.entries.map(entry => entry.actorId)).toEqual([other]);
	expect(auditActor(creations.entries[0], 'en', creations.references)).toBe('Ada');
	expect(auditActor(creations.entries[0], 'en', {})).toBe('Unknown admin');
	await expect(readNewProducts(session, 'yesterday')).rejects.toThrow();
	await expect(readNewProducts({ client: stub({ 'products:createdSince': () => [{ ...product(2, 'soon') }] }, []), userId: viewer }, since)).rejects.toThrow();
});
