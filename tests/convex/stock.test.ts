// Ledger, counts, corrections and idempotent retries (datamodell.md §5, §8).
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, internal, product, rejected, staff, uuid } from './harness';

describe.skipIf(!enabled)('stock ledger', () => {
	beforeEach(freshDeployment);

	async function stockOf(client: Awaited<ReturnType<typeof staff>>['client'], productId: string) {
		const [level] = await client.query(api.stock.inventory, { productIds: [productId] });
		return level;
	}

	test('a single count sets the balance and posts only the difference', async () => {
		const { client } = await staff();
		const p = await product(client);
		expect(await stockOf(client, p.id)).toMatchObject({ quantity: '0', revision: 0, last_counted_at: null });
		const first = await client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: '0', counted: '40', note: null });
		expect(first).toMatchObject({ quantity: '40', difference: '40' });
		const after = await stockOf(client, p.id);
		expect(after.quantity).toBe('40');
		expect(after.last_counted_at).not.toBeNull();
		// A matching count posts no movement, so the revision stays.
		await client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: String(after.revision), counted: '40', note: null });
		expect((await stockOf(client, p.id)).revision).toBe(after.revision);
	});

	test('a count against an old revision is stale', async () => {
		const { client } = await staff();
		const p = await product(client);
		await client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: '0', counted: '5', note: null });
		expect(await rejected(client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: '0', counted: '6', note: null })))
			.toBe('STALE_STOCK_COUNT');
	});

	test('quantities respect the stock step and adjustments need a reason', async () => {
		const { client } = await staff();
		const p = await product(client);
		expect(await rejected(client.mutation(api.stock.adjust, { requestId: uuid(), items: [{ productId: p.id, quantityDelta: '1.5' }], reason: 'test' })))
			.toBe('INVALID_QUANTITY_STEP');
		expect(await rejected(client.mutation(api.stock.adjust, { requestId: uuid(), items: [{ productId: p.id, quantityDelta: '1' }], reason: '  ' })))
			.toBe('REASON_REQUIRED');
		await client.mutation(api.stock.withdraw, { requestId: uuid(), items: [{ productId: p.id, quantity: '3' }], reason: 'Workshop use' });
		expect((await stockOf(client, p.id)).quantity).toBe('-3');
	});

	test('a retry returns the first result; reusing the key for other input is refused', async () => {
		const { client } = await staff();
		const p = await product(client);
		const requestId = uuid();
		const args = { requestId, items: [{ productId: p.id, quantityDelta: '7' }], reason: 'Found in drawer' };
		const first = await client.mutation(api.stock.adjust, args);
		expect(await client.mutation(api.stock.adjust, args)).toEqual(first);
		expect((await stockOf(client, p.id)).quantity).toBe('7');
		expect(await rejected(client.mutation(api.stock.adjust, { ...args, reason: 'Something else' }))).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
	});

	test('a correction after a later count requires a recount, which corrects and counts atomically', async () => {
		const { client } = await staff();
		const p = await product(client);
		await client.mutation(api.stock.adjust, { requestId: uuid(), items: [{ productId: p.id, quantityDelta: '60' }], reason: 'Delivery' });
		const detail = await client.query(api.stock.detail, { productId: p.id });
		const movementId = detail.movements[0].id;
		await client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: p.id, expectedRevision: detail.stock.revision, counted: '55', note: null });
		const revision = (await client.query(api.stock.detail, { productId: p.id })).stock.revision;
		expect(await rejected(client.mutation(api.stock.adjust, { requestId: uuid(), reason: 'Typo',
			items: [{ productId: p.id, quantityDelta: '-50', correctsMovementId: movementId, expectedRevision: revision }] }))).toBe('CORRECTION_REQUIRES_RECOUNT');
		const result = await client.mutation(api.stock.correctAndCount, { requestId: uuid(), correctsMovementId: movementId, expectedRevision: revision,
			quantityDelta: '-50', counted: '5', reason: 'Typo: 10 delivered, not 60' });
		expect(result.quantity).toBe('5');
		const after = await client.query(api.stock.detail, { productId: p.id });
		expect(after.stock.quantity).toBe('5');
		expect(after.movements.some((m) => m.corrects === movementId)).toBe(true);
	});

	test('the projection always equals the ledger', async () => {
		const { client } = await staff();
		const p = await product(client);
		for (const delta of ['5', '-2', '10']) await client.mutation(api.stock.adjust, { requestId: uuid(), items: [{ productId: p.id, quantityDelta: delta }], reason: 'test' });
		expect(await internal('query', 'migration:verifyStockLevels')).toEqual([]);
		expect((await stockOf(client, p.id)).quantity).toBe('13');
	});

	test('count batches belong to their owner until the owner is gone', async () => {
		const owner = await staff('Owner');
		const other = await staff('Other');
		const p = await product(owner.client);
		const { batch_id } = await owner.client.mutation(api.stock.startCountBatch, { requestId: uuid(), title: 'Drawer A' });
		expect(await rejected(other.client.mutation(api.stock.recordCount, { requestId: uuid(), batchId: batch_id, productId: p.id, expectedRevision: '0', counted: '1', note: null })))
			.toBe('COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER');
		expect(await rejected(other.client.mutation(api.stock.closeAbandonedCountBatch, { requestId: uuid(), batchId: batch_id, reason: 'Left' })))
			.toBe('COUNT_BATCH_OWNER_STILL_ACTIVE');
		await owner.client.mutation(api.stock.recordCount, { requestId: uuid(), batchId: batch_id, productId: p.id, expectedRevision: '0', counted: '4', note: null });
		await owner.client.mutation(api.stock.finishCountBatch, { batchId: batch_id });
		expect(await rejected(owner.client.mutation(api.stock.recordCount, { requestId: uuid(), batchId: batch_id, productId: p.id, expectedRevision: '1', counted: '4', note: null })))
			.toBe('COUNT_BATCH_FINISHED');
	});

	test('non-staff and signed-out callers are refused', async () => {
		const disabled = await staff('Gone', false);
		expect(await rejected(disabled.client.query(api.stock.inventory, {}))).toBe('STAFF_REQUIRED');
	});
});
