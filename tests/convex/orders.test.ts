// Placed orders, receipts, cancellations and receipt corrections (datamodell.md §6).
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, product, rejected, staff, uuid } from './harness';

describe.skipIf(!enabled)('orders', () => {
	beforeEach(freshDeployment);

	test('receipts, cancellations and their reversal drive outstanding quantity; only receipts add stock', async () => {
		const { client } = await staff();
		const p = await product(client);
		const { order_id } = await client.mutation(api.orders.recordOrder, { requestId: uuid(), supplierName: 'Elfa', placedAt: new Date().toISOString(),
			additionalCostNok: '49.00', supplierReference: 'SO-1', note: null,
			items: [{ productId: p.id, quantity: '100', unitCostNok: '0.20', purchaseUrl: 'https://example.invalid/r', supplierSku: 'R-1' }] });
		const line = async () => (await client.query(api.orders.detail, { orderId: order_id }))!.lines[0];
		expect((await line()).outstandingQuantity).toBe('100');
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('0');
		const lineId = (await line()).id;
		await client.mutation(api.orders.recordReceipt, { requestId: uuid(), orderId: order_id, note: null, occurredAt: null,
			items: [{ productId: p.id, orderLineId: lineId, quantity: '60' }] });
		expect(await rejected(client.mutation(api.orders.recordReceipt, { requestId: uuid(), orderId: order_id, note: null, occurredAt: null,
			items: [{ productId: p.id, orderLineId: lineId, quantity: '41' }] }))).toBe('RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY');
		await client.mutation(api.orders.cancelQuantities, { requestId: uuid(), orderId: order_id, reason: 'Back-ordered', items: [{ orderLineId: lineId, quantity: '40' }] });
		expect((await line()).outstandingQuantity).toBe('0');
		const detail = (await client.query(api.orders.detail, { orderId: order_id }))!;
		const cancellation = detail.cancellations[0].id;
		await client.mutation(api.orders.reverseCancellation, { requestId: uuid(), cancellationId: cancellation, reason: 'Arrived after all' });
		expect(await rejected(client.mutation(api.orders.reverseCancellation, { requestId: uuid(), cancellationId: cancellation, reason: 'Again' })))
			.toBe('CANCELLATION_ALREADY_REVERSED');
		expect((await line()).outstandingQuantity).toBe('40');
		expect((await client.query(api.stock.inventory, { productIds: [p.id] }))[0].quantity).toBe('60');
	});

	test('a receipt correction keeps its order allocation and stays within the ordered quantity', async () => {
		const { client } = await staff();
		const p = await product(client);
		const { order_id } = await client.mutation(api.orders.recordOrder, { requestId: uuid(), supplierName: 'Elfa', placedAt: new Date().toISOString(),
			additionalCostNok: '0', supplierReference: null, note: null, items: [{ productId: p.id, quantity: '100', unitCostNok: '1', purchaseUrl: null, supplierSku: null }] });
		const lineId = (await client.query(api.orders.detail, { orderId: order_id }))!.lines[0].id;
		await client.mutation(api.orders.recordReceipt, { requestId: uuid(), orderId: order_id, note: null, occurredAt: null,
			items: [{ productId: p.id, orderLineId: lineId, quantity: '60' }] });
		const stock = await client.query(api.stock.detail, { productId: p.id });
		const receipt = stock.movements[0];
		await client.mutation(api.stock.adjust, { requestId: uuid(), reason: 'Counted the box: 10',
			items: [{ productId: p.id, quantityDelta: '-50', correctsMovementId: receipt.id, expectedRevision: stock.stock.revision }] });
		const line = (await client.query(api.orders.detail, { orderId: order_id }))!.lines[0];
		expect(line).toMatchObject({ receivedQuantity: '10', outstandingQuantity: '90' });
		const after = await client.query(api.stock.detail, { productId: p.id });
		expect(await rejected(client.mutation(api.stock.adjust, { requestId: uuid(), reason: 'Too far',
			items: [{ productId: p.id, quantityDelta: '-20', correctsMovementId: receipt.id, expectedRevision: after.stock.revision }] }))).toBe('RECEIPT_CORRECTION_OUT_OF_RANGE');
	});

	test('orders cannot be placed far in the future; unplanned receipts need a source note', async () => {
		const { client } = await staff();
		const p = await product(client);
		expect(await rejected(client.mutation(api.orders.recordOrder, { requestId: uuid(), supplierName: 'Elfa', placedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
			additionalCostNok: '0', supplierReference: null, note: null, items: [{ productId: p.id, quantity: '1', unitCostNok: '1', purchaseUrl: null, supplierSku: null }] })))
			.toBe('ORDER_PLACED_IN_FUTURE');
		expect(await rejected(client.mutation(api.orders.recordReceipt, { requestId: uuid(), orderId: null, note: ' ', occurredAt: null,
			items: [{ productId: p.id, orderLineId: null, quantity: '1' }] }))).toBe('UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE');
		await client.mutation(api.orders.recordReceipt, { requestId: uuid(), orderId: null, note: 'Donation from Ola', occurredAt: null,
			items: [{ productId: p.id, orderLineId: null, quantity: '5' }] });
		expect(await client.query(api.orders.unplannedReceipts, {})).toHaveLength(1);
	});
});
