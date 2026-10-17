import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { memory } from './test-storage';
import { rejection, type ConvexCaller } from './convex';
import { clearOrderCommand, metadataRejected, orderProductName, orderCommandPath, orderRejection, readOrderCommand, readOrderDetail, readOrderProducts, readOutstandingByProduct, runOrderCommand, saveOrderCommand, updateOrderMetadata, type Order, type OrderCommand, type OrderProduct } from './admin-orders';

const userId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const lineId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';

/** A Convex client stub answering by function name (`orders:recordOrder`). */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const run = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { session: { client: { query: run, mutation: run, action: run } as unknown as ConvexCaller, userId }, calls };
}

test('order reads narrow products, keep exact outstanding sums and read a missing order as empty', async () => {
	const { session } = stub({
		'products:list': () => [
			{ id: userId, code: 'RES-00002', name_nb: 'Motstand', name_en: 'Resistor', unit_code: 'pcs', stock_step: '1', minimum_stock: '0', is_active: true, purchase_url: null, bin_id: null, location_note: null },
			{ id: productId, code: 'CAB-0001E', name_nb: 'Kabel', name_en: 'Cable', unit_code: 'm', stock_step: '0.000001', minimum_stock: '0', is_active: false, purchase_url: 'https://example.com', bin_id: null, location_note: null }
		],
		'orders:outstandingByProduct': () => ({ [productId]: '999999999998.999999', [userId]: '3' }),
		'orders:detail': () => null
	});
	const products = await readOrderProducts(session);
	expect(products.map((product) => product.code)).toEqual(['CAB-0001E', 'RES-00002']);
	expect(Object.keys(products[0]).sort()).toEqual(['code', 'id', 'is_active', 'minimum_stock', 'name_en', 'name_nb', 'purchase_url', 'stock_step', 'unit_code']);
	expect(await readOutstandingByProduct(session)).toEqual(new Map([[productId, '999999999998.999999'], [userId, '3']]));
	expect(await readOrderDetail(session, orderId)).toEqual({ order: null, lines: [], products: [], actors: [], cancellations: [], receipts: [] });
	await expect(readOrderDetail(session, 'not-an-id')).rejects.toThrow();
});

test('order product names use the locale and never fall back to an identifier', () => {
	const product: OrderProduct = { id: productId, code: 'CAB-0001E', name_nb: 'Kabel', name_en: 'Cable', unit_code: 'm', stock_step: '1', minimum_stock: '0', is_active: false, purchase_url: null };
	expect(orderProductName(product, 'nb')).toBe('Kabel');
	expect(orderProductName(product, 'en')).toBe('Cable');
	expect(orderProductName(undefined, 'nb')).toBe('Ukjent produkt');
	expect(orderProductName(undefined, 'en')).toBe('Unknown product');
});
const command: OrderCommand = { kind: 'create', userId, requestId, supplierName: 'Supplier', placedAt: '2026-09-20T10:00:00Z', additionalCostNok: '0.01', supplierReference: null, note: null,
	items: [{ productId, quantity: '999999999999', unitCostNok: '0.000001', purchaseUrl: null, supplierSku: 'SKU-1' }] };

test('order command freezes actor and exact payload across uncertain retries', async () => {
	const storage = memory();
	saveOrderCommand(storage, command);
	expect(readOrderCommand(storage)).toEqual(command);
	expect(() => saveOrderCommand(storage, { ...command, items: [{ ...command.items[0], quantity: '1' }] })).toThrow('Unresolved');
	expect(() => clearOrderCommand(storage, { ...command, userId: productId })).toThrow('changed');
	const { session, calls } = stub({ 'orders:recordOrder': () => ({ order_id: orderId }) });
	expect(await runOrderCommand(session, command)).toEqual({ kind: 'create', orderId });
	expect(await runOrderCommand(session, command)).toEqual({ kind: 'create', orderId });
	expect(calls[0].args).toEqual(calls[1].args);
	expect(calls[0].args).toEqual({ requestId, supplierName: 'Supplier', placedAt: '2026-09-20T10:00:00Z', additionalCostNok: '0.01', supplierReference: null, note: null,
		items: [{ productId, quantity: '999999999999', unitCostNok: '0.000001', purchaseUrl: null, supplierSku: 'SKU-1' }] });
	expect(orderCommandPath(command)).toBe('/admin/orders');
	expect(orderCommandPath({ kind: 'receipt', userId, requestId, orderId, note: null, occurredAt: null, items: [{ productId, orderLineId: lineId, quantity: '1' }] })).toBe(`/admin/orders/${orderId}`);
	await expect(runOrderCommand({ ...session, userId: productId }, command)).rejects.toThrow('identity');
	expect(calls).toHaveLength(2);
	clearOrderCommand(storage, command); expect(readOrderCommand(storage)).toBeNull();
});

test('receipts, cancellations and reversals reach their own mutation and must answer for the same order', async () => {
	const { session, calls } = stub({
		'orders:recordReceipt': () => ({ event_id: eventId }),
		'orders:cancelQuantities': () => ({ order_id: orderId }),
		'orders:reverseCancellation': (args) => ({ cancellation_id: eventId, order_id: args.cancellationId === lineId ? orderId : productId })
	});
	expect(await runOrderCommand(session, { kind: 'receipt', userId, requestId, orderId, note: null, occurredAt: null, items: [{ productId, orderLineId: lineId, quantity: '0.000001' }] })).toEqual({ kind: 'receipt', eventId });
	expect(calls[0].args).toEqual({ requestId, orderId, note: null, occurredAt: null, items: [{ productId, orderLineId: lineId, quantity: '0.000001' }] });
	expect(await runOrderCommand(session, { kind: 'cancel', userId, requestId, orderId, reason: 'Supplier out of stock', items: [{ orderLineId: lineId, quantity: '2' }] })).toEqual({ kind: 'cancel', orderId });
	expect(calls[1].args).toEqual({ requestId, orderId, reason: 'Supplier out of stock', items: [{ orderLineId: lineId, quantity: '2' }] });
	expect(await runOrderCommand(session, { kind: 'reverse', userId, requestId, orderId, cancellationId: lineId, reason: 'Arrived after all' })).toEqual({ kind: 'reverse', cancellationId: eventId, orderId });
	await expect(runOrderCommand(session, { kind: 'reverse', userId, requestId, orderId, cancellationId: eventId, reason: 'Arrived after all' })).rejects.toThrow('reversal');
});

test('only a domain rejection releases a command; unknown outcomes and lost access keep it', () => {
	expect(orderRejection(rejection('RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY'))).toBe('stale');
	expect(orderRejection(rejection('INVALID_CANCELLATION_QUANTITY'))).toBe('stale');
	expect(orderRejection(rejection('ORDER_LINE_NOT_FOUND', `ORDER_LINE_NOT_FOUND: ${lineId}`))).toBe('invalid');
	for (const error of [new Error('Timeout'), new TypeError('Failed to fetch'), rejection('STAFF_REQUIRED'), rejection('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT')]) expect(orderRejection(error)).toBeNull();
	expect(metadataRejected(rejection('INVALID_URL'))).toBe(true);
	expect(metadataRejected(new Error('Connection lost'))).toBe(false);
	expect(metadataRejected(rejection('STAFF_REQUIRED'))).toBe(false);
});

test('a metadata correction compares against the row the editor showed', async () => {
	const basis: Order = { id: orderId, requestId, supplierName: 'Supplier', supplierReference: null, placedAt: '2026-09-20T10:00:00.000000Z', additionalCostNok: '0.01', note: null, createdBy: userId, recordedAt: '2026-09-20T11:00:00.000000Z', lineCount: 1, openLineCount: 1 };
	const next = { supplierName: 'Supplier AS', supplierReference: 'PO-1', placedAt: basis.placedAt, additionalCostNok: '12.5', note: null };
	const { session, calls } = stub({ 'orders:updateOrder': () => 'stale' });
	expect(await updateOrderMetadata(session, basis, next)).toBe('stale');
	expect(calls[0].args).toEqual({ id: orderId, expected: { supplierName: 'Supplier', supplierReference: null, placedAt: basis.placedAt, additionalCostNok: '0.01', note: null }, next });
});
