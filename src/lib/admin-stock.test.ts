import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { memory } from './test-storage';
import { rejection, type ConvexCaller } from './convex';
import { clearStockCommand, needsRecount, readStockCommand, readStockProducts, runStockCommand, saveStockCommand, stockQuantity, stockRejection, type StockCommand, type StockDetail } from './admin-stock';

const productId = '11111111-1111-4111-8111-111111111111';
const lineId = '22222222-2222-4222-8222-222222222222';
const event1 = '33333333-3333-4333-8333-333333333333';
const event2 = '44444444-4444-4444-8444-444444444444';
const event3 = '55555555-5555-4555-8555-555555555555';

/** A Convex client stub answering by function name (`stock:adjust`). */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const run = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { session: { client: { query: run, mutation: run, action: run } as unknown as ConvexCaller, userId: productId }, calls };
}

test('products keep their minimum and state, and a correction behind a later count needs a recount', async () => {
	const { session } = stub({ 'products:list': () => [{ id: productId, code: 'DIO-00001', name_nb: 'Diode', name_en: 'Diode', unit_code: 'pcs', stock_step: '1', minimum_stock: '5', is_active: false, bin_id: null, purchase_url: null }] });
	expect((await readStockProducts(session))[0]).toEqual({ id: productId, code: 'DIO-00001', name_nb: 'Diode', name_en: 'Diode', unit_code: 'pcs', stock_step: '1', minimum_stock: '5', is_active: false });
	const detail: StockDetail = {
		stock: { productId, quantity: '7', revision: '3', lastCountedAt: '2026-09-23T10:00:00Z' },
		movements: [
			{ id: '3', eventId: event3, delta: '-3', kind: 'adjustment', note: 'Correction', at: '2026-09-23T11:00:00Z', actor: 'Ada', corrects: '1', orderLineId: lineId, orderId: event1, received: '7', outstanding: '3' },
			{ id: '1', eventId: event1, delta: '10', kind: 'receipt', note: 'Delivery', at: '2026-09-23T09:00:00Z', actor: 'Ada', corrects: null, orderLineId: lineId, orderId: event1, received: '7', outstanding: '3' }
		],
		counts: [{ eventId: event2, revision: '1', expected: '10', quantity: '10', at: '2026-09-23T10:00:00Z', actor: 'Ada', note: '' }]
	};
	expect(needsRecount(detail, '1')).toBe(true);
	expect(needsRecount(detail, '3')).toBe(false);
	expect(needsRecount(detail, '9007199254740993')).toBe(false);
});

test('correction with recount uses one atomic mutation and exact decimal strings', async () => {
	const command: StockCommand = { userId: productId, requestId: event2, kind: 'correct', productId, quantity: '-3', reason: 'Receipt error', movementId: '9007199254740993', revision: '9007199254740994', counted: '7' };
	const { session, calls } = stub({ 'stock:correctAndCount': () => ({ correction_event_id: event3, count_event_id: event2, batch_id: event1, quantity: '7' }) });
	expect(await runStockCommand(session, command)).toBe(event3);
	expect(calls).toEqual([{ name: 'stock:correctAndCount', args: { requestId: event2, correctsMovementId: '9007199254740993', expectedRevision: '9007199254740994', quantityDelta: '-3', counted: '7', reason: 'Receipt error' } }]);
	expect(stockQuantity('-0,5', '0.25', true, 'nb')).toBe('-0.5');
	expect(() => stockQuantity('0.3', '0.25', false, 'en')).toThrow();
	const storage = memory();
	saveStockCommand(storage, command);
	expect(readStockCommand(storage)).toEqual(command);
	expect(() => saveStockCommand(storage, { ...command, requestId: event3 })).toThrow('Unresolved stock command');
	clearStockCommand(storage, command);
	expect(readStockCommand(storage)).toBeNull();
	await expect(runStockCommand({ ...session, userId: event1 }, command)).rejects.toThrow('identity');
});

test('an unresolved ordinary correction retries its original adjustment payload', async () => {
	const command: StockCommand = { userId: productId, requestId: event2, kind: 'correct', productId, quantity: '-2', reason: 'Earlier receipt was high', movementId: '1', revision: '3', counted: null };
	const { session, calls } = stub({ 'stock:adjust': () => ({ event_id: event3 }), 'stock:withdraw': () => ({ event_id: event1 }) });
	await runStockCommand(session, command);
	await runStockCommand(session, command);
	expect(calls[0]).toEqual({ name: 'stock:adjust', args: { requestId: event2, items: [{ productId, quantityDelta: '-2', correctsMovementId: '1', expectedRevision: '3' }], reason: 'Earlier receipt was high' } });
	expect(calls[1]).toEqual(calls[0]);
	expect(await runStockCommand(session, { ...command, kind: 'withdraw', quantity: '2', movementId: null, revision: null })).toBe(event1);
	expect(calls[2].args).toEqual({ requestId: event2, items: [{ productId, quantity: '2' }], reason: 'Earlier receipt was high' });
});

test('only a domain rejection releases a stock command', () => {
	expect(stockRejection(rejection('STALE_STOCK_CORRECTION'))).toBe('stale');
	expect(stockRejection(rejection('CORRECTION_REQUIRES_RECOUNT'))).toBe('recount');
	expect(stockRejection(rejection('CORRECTED_MOVEMENT_NOT_FOUND', 'CORRECTED_MOVEMENT_NOT_FOUND: 7'))).toBe('invalid');
	for (const error of [new Error('Timeout'), rejection('STAFF_REQUIRED'), rejection('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT')]) expect(stockRejection(error)).toBeNull();
});
