import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { clearStockCommand, needsRecount, readStockCommand, readStockDetail, readStockProducts, runStockCommand, saveStockCommand, stockQuantity, type StockCommand } from './admin-stock';

const productId = '11111111-1111-4111-8111-111111111111';
const lineId = '22222222-2222-4222-8222-222222222222';
const event1 = '33333333-3333-4333-8333-333333333333';
const event2 = '44444444-4444-4444-8444-444444444444';
const event3 = '55555555-5555-4555-8555-555555555555';
const session = { config: { url: 'https://fixture.invalid', publishableKey: 'fixture' }, token: 'staff-jwt', userId: productId };
const movement1 = { id: '1', event_id: event1, product_id: productId, quantity_delta: '10' };
const movement3 = { id: '3', event_id: event3, product_id: productId, quantity_delta: '-3' };

test('stock history retains correction provenance, order progress and a zero-difference intervening count', async () => {
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const path = url.pathname.split('/').at(-1);
		const after = url.searchParams.get('and');
		let data: unknown[] = [];
		if (path === 'amp_products') {
			expect(url.searchParams.get('select')).toContain('minimum_stock');
			data = [{ id: productId, code: 'DIO-00001', name_nb: 'Diode', name_en: 'Diode', unit_code: 'pcs', stock_step: '1', minimum_stock: '5', is_active: false }];
		}
		if (path === 'amp_inventory') data = [{ product_id: productId, quantity: '7', revision: '3', last_counted_at: '2026-09-23T10:00:00Z' }];
		if (path === 'amp_inventory_movements') data = after === '(id.gt.1)' ? [movement3] : after ? [] : [movement1];
		if (path === 'amp_stock_counts') data = [{ event_id: event2, product_id: productId, expected_revision: '1', expected_quantity: '10', counted_quantity: '10' }];
		if (path === 'amp_inventory_events') data = [
			{ id: event1, kind: 'receipt', note: 'Delivery', recorded_at: '2026-09-23T09:00:00Z', actor_id: productId },
			{ id: event2, kind: 'count', note: '', recorded_at: '2026-09-23T10:00:00Z', actor_id: productId },
			{ id: event3, kind: 'adjustment', note: 'Correction', recorded_at: '2026-09-23T11:00:00Z', actor_id: productId }
		];
		if (path === 'amp_staff_members') data = [{ id: productId, display_name: 'Ada' }];
		if (path === 'amp_movement_corrections' && !after) data = [{ movement_id: '3', corrects_movement_id: '1' }];
		if (path === 'amp_receipt_allocations' && !after) data = [{ movement_id: '1', order_line_id: lineId }, { movement_id: '3', order_line_id: lineId }];
		if (path === 'amp_purchase_line_progress') data = [{ id: lineId, order_id: event1, received_quantity: '7', outstanding_quantity: '3' }];
		return new Response(JSON.stringify(after && path !== 'amp_inventory_movements' ? [] : data));
	};
	const products = await readStockProducts(session, fetcher);
	expect(products[0]).toMatchObject({ code: 'DIO-00001', name_nb: 'Diode', minimum_stock: '5', is_active: false });
	const detail = await readStockDetail(session, productId, fetcher);
	expect(detail.movements.map(item => item.id)).toEqual(['3', '1']);
	expect(detail.movements[0].corrects).toBe('1');
	expect(detail.movements[0].received).toBe('7');
	expect(detail.counts[0].note).toBe('');
	expect(needsRecount(detail, '1')).toBe(true);
	expect(needsRecount(detail, '3')).toBe(false);
});

test('correction with recount uses one atomic RPC and exact decimal strings', async () => {
	const command: StockCommand = { userId: productId, requestId: event2, kind: 'correct', productId, quantity: '-3', reason: 'Receipt error', movementId: '9007199254740993', revision: '9007199254740994', counted: '7' };
	let path = '', body = {};
	const result = await runStockCommand(session, command, async (input, init) => {
		path = new URL(String(input)).pathname;
		body = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ correction_event_id: event3, count_event_id: event2, batch_id: event1, quantity: '7' }));
	});
	expect(result).toBe(event3);
	expect(path).toEndWith('/rpc/amp_correct_movement_and_count');
	expect(body).toMatchObject({ p_corrects_movement_id: '9007199254740993', p_expected_revision: '9007199254740994', p_quantity_delta: '-3', p_counted_quantity: '7' });
	expect(stockQuantity('-0,5', '0.25', true, 'nb')).toBe('-0.5');
	expect(() => stockQuantity('0.3', '0.25', false, 'en')).toThrow();
	const storage = memory();
	saveStockCommand(storage, command);
	expect(readStockCommand(storage)).toEqual(command);
	expect(() => saveStockCommand(storage, { ...command, requestId: event3 })).toThrow('Unresolved stock command');
	clearStockCommand(storage, command);
	expect(readStockCommand(storage)).toBeNull();
});

test('an unresolved ordinary correction retries its original adjustment payload', async () => {
	const command: StockCommand = { userId: productId, requestId: event2, kind: 'correct', productId, quantity: '-2', reason: 'Earlier receipt was high', movementId: '1', revision: '3', counted: null };
	let path = '', body: Record<string, unknown> = {};
	await runStockCommand(session, command, async (input, init) => {
		path = new URL(String(input)).pathname; body = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ event_id: event3 }));
	});
	expect(path).toEndWith('/rpc/amp_adjust_stock');
	expect(body.p_items).toEqual([{ product_id: productId, quantity_delta: '-2', corrects_movement_id: '1', expected_revision: '3' }]);
});
