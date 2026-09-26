import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { ApiError } from './api';
import { clearOrderCommand, orderCommandPath, orderRejection, readOrderCommand, readOrderDetail, readOutstandingByProduct, runOrderCommand, saveOrderCommand, type OrderCommand } from './admin-orders';

const userId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const lineId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-token', userId };
const command: OrderCommand = { kind: 'create', userId, requestId, supplierName: 'Supplier', placedAt: '2026-09-20T10:00:00Z', additionalCostNok: '0.01', supplierReference: null, note: null,
	items: [{ productId, quantity: '999999999999', unitCostNok: '0.000001', purchaseUrl: null, supplierSku: 'SKU-1' }] };

test('order command freezes actor and exact payload across uncertain retries', async () => {
	const storage = memory();
	saveOrderCommand(storage, command);
	expect(readOrderCommand(storage)).toEqual(command);
	expect(() => saveOrderCommand(storage, { ...command, items: [{ ...command.items[0], quantity: '1' }] })).toThrow('Unresolved');
	expect(() => clearOrderCommand(storage, { ...command, userId: productId })).toThrow('changed');
	const bodies: string[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_record_order');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-token');
		bodies.push(String(init?.body));
		return Response.json({ order_id: orderId });
	};
	expect(await runOrderCommand(session, command, fetcher)).toEqual({ kind: 'create', orderId });
	expect(await runOrderCommand(session, command, fetcher)).toEqual({ kind: 'create', orderId });
	expect(bodies[0]).toBe(bodies[1]);
	expect(JSON.parse(bodies[0]).p_items).toEqual([{ product_id: productId, quantity: '999999999999', unit_cost_nok: '0.000001', purchase_url: null, supplier_sku: 'SKU-1' }]);
	expect(orderCommandPath(command)).toBe('/admin/orders');
	expect(orderCommandPath({ kind: 'receipt', userId, requestId, orderId, note: null, occurredAt: null, items: [{ productId, orderLineId: lineId, quantity: '1' }] })).toBe(`/admin/orders/${orderId}`);
	await expect(runOrderCommand({ ...session, userId: productId }, command, fetcher)).rejects.toThrow('identity');
	expect(bodies).toHaveLength(2);
	expect(orderRejection(new ApiError(400, { message: 'RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY' }))).toBe('stale');
	expect(orderRejection(new ApiError(500, null))).toBeNull();
	clearOrderCommand(storage, command); expect(readOrderCommand(storage)).toBeNull();
});

test('order detail follows allocation history and preserves exact quantities', async () => {
	const calls: URL[] = [];
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input)), view = url.pathname.split('/').at(-1); calls.push(url);
		const cursor = url.searchParams.get('and') || url.searchParams.get('movement_id');
		if (view === 'amp_receipt_allocations') return Response.json(cursor === '(movement_id.gt.9007199254740993)' ? [{ movement_id: '9007199254740994', order_line_id: lineId }] : cursor ? [] : [{ movement_id: '9007199254740993', order_line_id: lineId }]);
		if (view === 'amp_inventory_movements') return new Response(cursor === '(id.gt.9007199254740993)'
			? `[{"id":9007199254740994,"event_id":"${eventId}","product_id":"${productId}","quantity_delta":0.000001}]`
			: cursor ? '[]' : `[{"id":9007199254740993,"event_id":"${eventId}","product_id":"${productId}","quantity_delta":0.000001}]`);
		if (cursor) return Response.json([]);
		if (view === 'amp_purchase_orders') return Response.json([{ id: orderId, request_id: requestId, supplier_name: 'Supplier', supplier_reference: null, placed_at: '2026-09-20T10:00:00Z', additional_cost_nok: '0.01', note: null, created_by: userId, recorded_at: '2026-09-20T11:00:00Z' }]);
		if (view === 'amp_purchase_line_progress') return Response.json([{ id: lineId, order_id: orderId, line_number: 1, product_id: productId, ordered_quantity: '999999999999', unit_cost_nok: '0.000001', purchase_url: null, supplier_sku: null, received_quantity: '0.000001', cancelled_quantity: '0', outstanding_quantity: '999999999998.999999' }]);
		if (view === 'amp_products') return Response.json([{ id: productId, code: 'CAB-0001E', name_nb: 'Kabel', name_en: 'Cable', unit_code: 'm', stock_step: '0.000001', is_active: true, purchase_url: null }]);
		if (view === 'amp_purchase_order_cancellations') return Response.json([]);
		if (view === 'amp_inventory_events') return Response.json([{ id: eventId, request_id: requestId, kind: 'receipt', actor_id: userId, purchase_order_id: orderId, note: null, occurred_at: '2026-09-20T12:00:00Z', recorded_at: '2026-09-20T12:00:00Z' }]);
		if (view === 'amp_staff_members') return Response.json([{ id: userId, display_name: 'Operator' }]);
		throw new Error(`Unexpected ${view}`);
	};
	const detail = await readOrderDetail(session, orderId, fetcher);
	expect(detail.order?.openLineCount).toBe(1);
	expect(detail.actors).toEqual([{ id: userId, name: 'Operator' }]);
	expect(detail.lines[0].outstandingQuantity).toBe('999999999998.999999');
	expect(detail.receipts[0].movements).toEqual([
		{ id: '9007199254740993', eventId, productId, quantityDelta: '0.000001', orderLineId: lineId },
		{ id: '9007199254740994', eventId, productId, quantityDelta: '0.000001', orderLineId: lineId }
	]);
	expect(calls.some(url => url.searchParams.get('and') === '(movement_id.gt.9007199254740993)')).toBe(true);
});

test('outstanding quantities sum exactly per product over open lines', async () => {
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		expect(url.searchParams.get('outstanding_quantity')).toBe('gt.0');
		return Response.json(url.searchParams.get('and') ? [] : [
			{ id: orderId, product_id: productId, outstanding_quantity: '0.1' },
			{ id: lineId, product_id: productId, outstanding_quantity: '0.2' },
			{ id: eventId, product_id: userId, outstanding_quantity: '3' }
		]);
	};
	expect(await readOutstandingByProduct(session, fetcher)).toEqual(new Map([[productId, '0.3'], [userId, '3']]));
});
