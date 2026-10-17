// Overlapping commands (docs/concurrency-tests.md). PostgreSQL needed row locks
// and READ COMMITTED for these; Convex mutations are serializable, so the losing
// transaction is retried and sees the winner's writes. These run truly in
// parallel against the backend.
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, guest, internal, product, serverKey, staff, uuid } from './harness';

const settle = (promises: Promise<unknown>[]) => Promise.allSettled(promises);

describe.skipIf(!enabled)('concurrency', () => {
	beforeEach(freshDeployment);

	test('two counts against the same revision: exactly one posts', async () => {
		const a = await staff('A'), b = await staff('B');
		const p = await product(a.client);
		const results = await settle([a.client, b.client].map((client, i) =>
			client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: '0', counted: String(10 + i), note: null })));
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(JSON.stringify(results.find((r) => r.status === 'rejected'))).toContain('STALE_STOCK_COUNT');
		expect(await internal<string[]>('query', 'migration:verifyStockLevels')).toEqual([]);
	});

	test('duplicate confirmations register one sale', async () => {
		const { client } = await staff();
		const p = await product(client);
		const token = 'ab'.repeat(32);
		const { checkout_id } = await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token, contact: null, items: [{ productId: p.id, quantity: '2' }] });
		const results = await Promise.all(Array.from({ length: 5 }, () => guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token })));
		expect(new Set(results.map((r) => r.confirmed_at)).size).toBe(1);
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('-2');
	});

	test('concurrent duplicates of one request ID get the same result and act once', async () => {
		const { client } = await staff();
		const p = await product(client);
		const args = { requestId: uuid(), items: [{ productId: p.id, quantityDelta: '3' }], reason: 'Parallel retry' };
		const results = await Promise.all(Array.from({ length: 5 }, () => client.mutation(api.stock.adjust, args)));
		expect(new Set(results.map((r) => r.event_id)).size).toBe(1);
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('3');
	});

	test('many sales of one product keep the ledger exact', async () => {
		const { client } = await staff();
		const p = await product(client);
		await Promise.all(Array.from({ length: 12 }, async (_, i) => {
			const token = i.toString(16).padStart(2, '0').repeat(32);
			const { checkout_id } = await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token, contact: null, items: [{ productId: p.id, quantity: '1' }] });
			await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token });
		}));
		const detail = await client.query(api.stock.detail, { productId: p.id });
		expect(detail.stock.quantity).toBe('-12');
		expect(new Set(detail.movements.map((m) => m.id)).size).toBe(12);
	});

	test('two members cannot deactivate each other at the same time', async () => {
		const a = await staff('A'), b = await staff('B');
		const results = await settle([a.client.mutation(api.members.deactivate, { requestId: uuid(), staffId: b.staffId }),
			b.client.mutation(api.members.deactivate, { requestId: uuid(), staffId: a.staffId })]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(JSON.stringify(results.find((r) => r.status === 'rejected'))).toContain('STAFF_REQUIRED');
	});
});
