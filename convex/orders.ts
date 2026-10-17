/**
 * Purchase orders, receipts and cancellations (datamodell.md §6). Orders
 * record what was already placed elsewhere; only receipts add stock.
 */
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { insertAudited, patchAudited } from './lib/audit';
import { beginCommand } from './lib/commands';
import { addDecimals, checkedNokAmount, checkedUnitPrice, compareDecimals } from './lib/decimal';
import { fail } from './lib/errors';
import { byUuid, newUuid } from './lib/ids';
import { insertAllocation, insertEvent, insertMovement, lineProgress, requireProduct, validateQuantity } from './lib/inventory';
import { requireStaff } from './lib/staff';
import { isoNow } from './lib/time';

const nullableString = v.union(v.string(), v.null());
const DAY = 86_400_000;

function timestampArg(value: string, code: string): string {
	const ms = Date.parse(value);
	if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(ms)) fail(code);
	return new Date(ms).toISOString().replace(/Z$/, '000Z');
}
function webLink(value: string | null): string | null {
	if (value === null || value === '') return null;
	if (!/^https?:\/\//.test(value)) fail('INVALID_URL');
	return value;
}
function optionalText(value: string | null, max = 2000): string | null {
	if (value !== null && [...value].length > max) fail('TEXT_TOO_LONG');
	return value;
}
function items<T>(list: T[]): T[] {
	if (list.length < 1 || list.length > 200) fail('INVALID_ITEM_COUNT');
	return list;
}

export const recordOrder = mutation({
	args: {
		requestId: v.string(), supplierName: v.string(), placedAt: v.string(), additionalCostNok: v.string(),
		supplierReference: nullableString, note: nullableString,
		items: v.array(v.object({ productId: v.string(), quantity: v.string(), unitCostNok: v.string(), purchaseUrl: nullableString, supplierSku: nullableString }))
	},
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ order_id: string }>(ctx, requestId, 'record_order', actor.staffId, body);
		if (command.done) return command.result;
		const placedAt = timestampArg(args.placedAt, 'PLACED_AT_REQUIRED');
		if (Date.parse(placedAt) > Date.now() + DAY) fail('ORDER_PLACED_IN_FUTURE');
		if (!args.supplierName.trim() || [...args.supplierName.trim()].length > 200) fail('SUPPLIER_NAME_REQUIRED');
		const order = await insertAudited(ctx, actor, 'purchase_orders', { id: newUuid(), request_id: requestId, supplier_name: args.supplierName,
			supplier_reference: optionalText(args.supplierReference), placed_at: placedAt, additional_cost_nok: checkedNokAmount(args.additionalCostNok),
			note: optionalText(args.note), created_by: actor.staffId!, recorded_at: isoNow() });
		let lineNumber = 0;
		for (const item of items(args.items)) {
			const product = await requireProduct(ctx, item.productId);
			const quantity = validateQuantity(product, item.quantity);
			if (compareDecimals(quantity, '0') <= 0) fail('POSITIVE_ORDER_QUANTITY_REQUIRED');
			await insertAudited(ctx, actor, 'purchase_order_lines', { id: newUuid(), order_id: order.id, line_number: ++lineNumber, product_id: product.id,
				ordered_quantity: quantity, unit_cost_nok: checkedUnitPrice(item.unitCostNok), purchase_url: webLink(item.purchaseUrl), supplier_sku: item.supplierSku || null });
		}
		return await command.finish({ order_id: order.id });
	}
});

export const recordReceipt = mutation({
	args: {
		requestId: v.string(), orderId: nullableString, note: nullableString, occurredAt: nullableString,
		items: v.array(v.object({ productId: v.string(), orderLineId: nullableString, quantity: v.string() }))
	},
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ event_id: string }>(ctx, requestId, 'record_receipt', actor.staffId, body);
		if (command.done) return command.result;
		items(args.items);
		if (args.orderId !== null) {
			if (!await byUuid(ctx, 'purchase_orders', args.orderId)) fail('ORDER_NOT_FOUND');
		} else if (!args.note?.trim()) fail('UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE');
		const event = await insertEvent(ctx, { request_id: requestId, kind: 'receipt', actor_id: actor.staffId, purchase_order_id: args.orderId,
			note: args.note, occurred_at: args.occurredAt === null ? undefined : timestampArg(args.occurredAt, 'INVALID_OCCURRED_AT') });
		for (const item of args.items) {
			const product = await requireProduct(ctx, item.productId);
			const quantity = validateQuantity(product, item.quantity);
			if (compareDecimals(quantity, '0') <= 0) fail('POSITIVE_RECEIPT_QUANTITY_REQUIRED');
			if (args.orderId !== null) {
				if (item.orderLineId === null) fail('RECEIPT_ORDER_LINE_REQUIRED');
				const line = (await byUuid(ctx, 'purchase_order_lines', item.orderLineId)) ?? fail('ORDER_LINE_NOT_FOUND', item.orderLineId);
				if (line.order_id !== args.orderId || line.product_id !== product.id) fail('RECEIPT_ORDER_LINE_MISMATCH');
				// Earlier items of this same receipt already count towards progress.
				if (compareDecimals(quantity, (await lineProgress(ctx, line)).outstanding_quantity) > 0) fail('RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY');
			} else if (item.orderLineId !== null) fail('UNPLANNED_RECEIPT_CANNOT_HAVE_ORDER_LINE');
			const movementId = await insertMovement(ctx, event, product, quantity);
			if (item.orderLineId !== null) await insertAllocation(ctx, movementId, item.orderLineId);
		}
		return await command.finish({ event_id: event.id });
	}
});

export const cancelQuantities = mutation({
	args: { requestId: v.string(), orderId: v.string(), reason: v.string(), items: v.array(v.object({ orderLineId: v.string(), quantity: v.string() })) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ order_id: string }>(ctx, requestId, 'cancel_order_quantities', actor.staffId, body);
		if (command.done) return command.result;
		items(args.items);
		if (!await byUuid(ctx, 'purchase_orders', args.orderId)) fail('ORDER_NOT_FOUND');
		if (new Set(args.items.map((i) => i.orderLineId)).size !== args.items.length) fail('DUPLICATE_OR_MISSING_ORDER_LINE');
		if (!args.reason.trim() || [...args.reason].length > 2000) fail('REASON_REQUIRED');
		for (const item of args.items) {
			const line = await byUuid(ctx, 'purchase_order_lines', item.orderLineId);
			if (!line || line.order_id !== args.orderId) fail('ORDER_LINE_NOT_FOUND', item.orderLineId);
			const quantity = validateQuantity(await requireProduct(ctx, line.product_id), item.quantity);
			if (compareDecimals(quantity, '0') <= 0 || compareDecimals(quantity, (await lineProgress(ctx, line)).outstanding_quantity) > 0) fail('INVALID_CANCELLATION_QUANTITY');
			await ctx.db.insert('purchase_order_cancellations', { id: newUuid(), request_id: requestId, order_line_id: line.id, quantity,
				reverses_id: null, reason: args.reason, created_by: actor.staffId!, recorded_at: isoNow() });
		}
		return await command.finish({ order_id: args.orderId });
	}
});

export const reverseCancellation = mutation({
	args: { requestId: v.string(), cancellationId: v.string(), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ cancellation_id: string; order_id: string }>(ctx, requestId, 'reverse_cancellation', actor.staffId, body);
		if (command.done) return command.result;
		const cancellation = (await byUuid(ctx, 'purchase_order_cancellations', args.cancellationId)) ?? fail('CANCELLATION_NOT_FOUND');
		if (cancellation.reverses_id !== null) fail('CANNOT_REVERSE_A_REVERSAL');
		if (await ctx.db.query('purchase_order_cancellations').withIndex('reverses_id', (q) => q.eq('reverses_id', cancellation.id)).first()) fail('CANCELLATION_ALREADY_REVERSED');
		if (!args.reason.trim() || [...args.reason].length > 2000) fail('REASON_REQUIRED');
		const line = (await byUuid(ctx, 'purchase_order_lines', cancellation.order_line_id))!;
		const id = newUuid();
		await ctx.db.insert('purchase_order_cancellations', { id, request_id: requestId, order_line_id: line.id, quantity: cancellation.quantity,
			reverses_id: cancellation.id, reason: args.reason, created_by: actor.staffId!, recorded_at: isoNow() });
		return await command.finish({ cancellation_id: id, order_id: line.order_id });
	}
});

/**
 * Audited correction of order metadata. `expected` is the row as the editor
 * showed it; any difference means someone else changed it (returns 'stale').
 */
export const updateOrder = mutation({
	args: {
		id: v.string(),
		expected: v.object({ supplierName: v.string(), supplierReference: nullableString, placedAt: v.string(), additionalCostNok: v.string(), note: nullableString }),
		next: v.object({ supplierName: v.string(), supplierReference: nullableString, placedAt: v.string(), additionalCostNok: v.string(), note: nullableString })
	},
	handler: async (ctx, { id, expected, next }) => {
		const { actor } = await requireStaff(ctx);
		const order = await byUuid(ctx, 'purchase_orders', id);
		if (!order) return 'stale' as const;
		const matches = (row: typeof expected) => order.supplier_name === row.supplierName && order.supplier_reference === row.supplierReference
			&& Date.parse(order.placed_at) === Date.parse(row.placedAt) && compareDecimals(order.additional_cost_nok, row.additionalCostNok) === 0 && order.note === row.note;
		if (matches(next)) return 'saved' as const;
		if (!matches(expected)) return 'stale' as const;
		const placedAt = timestampArg(next.placedAt, 'PLACED_AT_REQUIRED');
		if (Date.parse(placedAt) > Date.parse(order.recorded_at) + DAY) fail('ORDER_PLACED_IN_FUTURE');
		if (!next.supplierName.trim() || [...next.supplierName.trim()].length > 200) fail('SUPPLIER_NAME_REQUIRED');
		await patchAudited(ctx, actor, 'purchase_orders', order, { supplier_name: next.supplierName, supplier_reference: optionalText(next.supplierReference),
			placed_at: placedAt, additional_cost_nok: checkedNokAmount(next.additionalCostNok), note: optionalText(next.note) });
		return 'saved' as const;
	}
});

export const updateOrderLine = mutation({
	args: {
		id: v.string(),
		expected: v.object({ unitCostNok: v.string(), purchaseUrl: nullableString, supplierSku: nullableString }),
		next: v.object({ unitCostNok: v.string(), purchaseUrl: nullableString, supplierSku: nullableString })
	},
	handler: async (ctx, { id, expected, next }) => {
		const { actor } = await requireStaff(ctx);
		const line = await byUuid(ctx, 'purchase_order_lines', id);
		if (!line) return 'stale' as const;
		const matches = (row: typeof expected) => compareDecimals(line.unit_cost_nok, row.unitCostNok) === 0 && line.purchase_url === row.purchaseUrl && line.supplier_sku === row.supplierSku;
		if (matches(next)) return 'saved' as const;
		if (!matches(expected)) return 'stale' as const;
		await patchAudited(ctx, actor, 'purchase_order_lines', line, { unit_cost_nok: checkedUnitPrice(next.unitCostNok), purchase_url: webLink(next.purchaseUrl), supplier_sku: next.supplierSku || null });
		return 'saved' as const;
	}
});

// ---------- Staff reads ----------

function orderRow(o: Doc<'purchase_orders'>, lines: { outstanding_quantity: string }[]) {
	return { id: o.id, requestId: o.request_id, supplierName: o.supplier_name, supplierReference: o.supplier_reference, placedAt: o.placed_at,
		additionalCostNok: o.additional_cost_nok, note: o.note, createdBy: o.created_by, recordedAt: o.recorded_at,
		lineCount: lines.length, openLineCount: lines.filter((l) => compareDecimals(l.outstanding_quantity, '0') > 0).length };
}
async function orderLines(ctx: Parameters<typeof lineProgress>[0], orderId: string) {
	const lines = await ctx.db.query('purchase_order_lines').withIndex('order_line', (q) => q.eq('order_id', orderId)).collect();
	return await Promise.all(lines.map((line) => lineProgress(ctx, line)));
}

/** Open orders first, then newest placement. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const result = [];
		for (const order of await ctx.db.query('purchase_orders').collect()) result.push(orderRow(order, await orderLines(ctx, order.id)));
		return result.sort((a, b) => Number(b.openLineCount > 0) - Number(a.openLineCount > 0) || b.placedAt.localeCompare(a.placedAt) || b.id.localeCompare(a.id));
	}
});

/** Quantity still expected from suppliers, summed per product. */
export const outstandingByProduct = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const totals: Record<string, string> = {};
		for (const line of await ctx.db.query('purchase_order_lines').collect()) {
			const { outstanding_quantity } = await lineProgress(ctx, line);
			if (compareDecimals(outstanding_quantity, '0') > 0) totals[line.product_id] = addDecimals(totals[line.product_id] ?? '0', outstanding_quantity);
		}
		return totals;
	}
});

async function receiptEvent(ctx: Parameters<typeof lineProgress>[0], event: Doc<'inventory_events'>, movements: { id: number; product_id: string; quantity_delta: string; orderLineId: string | null }[]) {
	return { id: event.id, requestId: event.request_id, kind: event.kind as 'receipt' | 'adjustment', actorId: event.actor_id!, purchaseOrderId: event.purchase_order_id,
		note: event.note, occurredAt: event.occurred_at, recordedAt: event.recorded_at,
		movements: movements.map((m) => ({ id: String(m.id), eventId: event.id, productId: m.product_id, quantityDelta: m.quantity_delta, orderLineId: m.orderLineId })) };
}

export const detail = query({
	args: { orderId: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const order = await byUuid(ctx, 'purchase_orders', args.orderId);
		if (!order) return null;
		const lines = (await orderLines(ctx, order.id)).sort((a, b) => a.line_number - b.line_number);
		const products = [];
		for (const id of new Set(lines.map((l) => l.product_id))) {
			const p = (await byUuid(ctx, 'products', id))!;
			products.push({ id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, unit_code: p.unit_code, stock_step: p.stock_step,
				minimum_stock: p.minimum_stock, is_active: p.is_active, purchase_url: p.purchase_url });
		}
		const cancellations = [];
		const byEvent = new Map<string, { id: number; product_id: string; quantity_delta: string; orderLineId: string | null }[]>();
		for (const line of lines) {
			for (const c of await ctx.db.query('purchase_order_cancellations').withIndex('order_line_id', (q) => q.eq('order_line_id', line.id)).collect()) {
				cancellations.push({ id: c.id, requestId: c.request_id, orderLineId: c.order_line_id, quantity: c.quantity, reversesId: c.reverses_id,
					reason: c.reason, createdBy: c.created_by, recordedAt: c.recorded_at });
			}
			for (const a of await ctx.db.query('receipt_allocations').withIndex('order_line_id', (q) => q.eq('order_line_id', line.id)).collect()) {
				const m = (await ctx.db.query('inventory_movements').withIndex('seq', (q) => q.eq('id', a.movement_id)).unique())!;
				byEvent.set(m.event_id, [...(byEvent.get(m.event_id) ?? []), { ...m, orderLineId: line.id }]);
			}
		}
		const receipts = [];
		for (const [eventId, movements] of byEvent) receipts.push(await receiptEvent(ctx, (await byUuid(ctx, 'inventory_events', eventId))!, movements));
		receipts.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
		const actorIds = new Set([order.created_by, ...cancellations.map((c) => c.createdBy), ...receipts.map((r) => r.actorId)]);
		const actors = [];
		for (const id of actorIds) actors.push({ id, name: (await byUuid(ctx, 'staff_members', id))?.display_name ?? '' });
		return {
			order: orderRow(order, lines),
			lines: lines.map((l) => ({ id: l.id, orderId: l.order_id, lineNumber: l.line_number, productId: l.product_id, orderedQuantity: l.ordered_quantity,
				unitCostNok: l.unit_cost_nok, purchaseUrl: l.purchase_url, supplierSku: l.supplier_sku, receivedQuantity: l.received_quantity,
				cancelledQuantity: l.cancelled_quantity, outstandingQuantity: l.outstanding_quantity })),
			products, actors,
			cancellations: cancellations.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id)),
			receipts
		};
	}
});

/** Receipts without an order (donations, finds), newest first. */
export const unplannedReceipts = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const events = await ctx.db.query('inventory_events').withIndex('kind_order', (q) => q.eq('kind', 'receipt').eq('purchase_order_id', null)).collect();
		const result = [];
		for (const event of events) {
			const movements = await ctx.db.query('inventory_movements').withIndex('event_id', (q) => q.eq('event_id', event.id)).collect();
			result.push(await receiptEvent(ctx, event, movements.map((m) => ({ ...m, orderLineId: null }))));
		}
		return result.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
	}
});
