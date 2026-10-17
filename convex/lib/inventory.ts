/**
 * The stock ledger (datamodell.md §5–6).
 *
 * Balances are the sum of `inventory_movements`; the revision is the newest
 * movement ID. `stock_levels` is a projection of those two values, written here
 * in the same transaction as every movement, and rebuildable from the ledger
 * (`migration:verifyStockLevels`). This module is the only writer of events,
 * movements, corrections, allocations and stock levels.
 *
 * PostgreSQL needed row locks and READ COMMITTED for these rules. Convex runs
 * each mutation as one serializable transaction: a balance or revision read
 * here cannot change before the mutation commits, or Convex retries it.
 */
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { addDecimals, checkedQuantity, checkedStockQuantity, compareDecimals, isMultipleOf, subtractDecimals, sumDecimals } from './decimal';
import { fail } from './errors';
import { byUuid, newUuid } from './ids';
import { nextSequence } from './sequence';
import { isoNow } from './time';

export type EventKind = Doc<'inventory_events'>['kind'];

export async function requireProduct(ctx: QueryCtx, id: string | null | undefined): Promise<Doc<'products'>> {
	if (!id) fail('PRODUCT_ID_REQUIRED');
	return (await byUuid(ctx, 'products', id)) ?? fail('PRODUCT_NOT_FOUND', id);
}

/**
 * `quantity` must be an exact multiple of the product's stock (or sale) step.
 * `unbounded` allows balances and counts beyond the command bound.
 */
export function validateQuantity(product: Doc<'products'>, quantity: unknown, options: { sale?: boolean; unbounded?: boolean } = {}): string {
	if (quantity === null || quantity === undefined) fail('QUANTITY_REQUIRED');
	const value = options.unbounded ? checkedStockQuantity(quantity) : checkedQuantity(quantity);
	if (!isMultipleOf(value, options.sale ? product.sale_step : product.stock_step)) fail('INVALID_QUANTITY_STEP');
	return value;
}

export type StockLevel = { product_id: string; quantity: string; revision: number; last_counted_at: string | null };
export async function stockLevel(ctx: QueryCtx, productId: string): Promise<StockLevel> {
	const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', productId)).unique();
	return level ? { product_id: productId, quantity: level.quantity, revision: level.revision, last_counted_at: level.last_counted_at }
		: { product_id: productId, quantity: '0', revision: 0, last_counted_at: null };
}

export async function insertEvent(ctx: MutationCtx, event: {
	request_id: string | null; kind: EventKind; actor_id: string | null; purchase_order_id?: string | null; note?: string | null; occurred_at?: string;
}): Promise<Doc<'inventory_events'>> {
	const note = event.note ?? null;
	const order = event.purchase_order_id ?? null;
	if ((event.kind === 'sale') !== (event.actor_id === null)) fail('INVALID_EVENT_ACTOR');
	if (event.kind !== 'receipt' && order !== null) fail('INVALID_EVENT_ORDER');
	if (note !== null && [...note].length > 2000) fail('NOTE_TOO_LONG');
	const hasNote = note !== null && note.trim().length > 0;
	if ((event.kind === 'adjustment' || event.kind === 'withdrawal') && !hasNote) fail('REASON_REQUIRED');
	if (event.kind === 'receipt' && order === null && !hasNote) fail('UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE');
	const now = isoNow();
	const row = { id: newUuid(), request_id: event.request_id, kind: event.kind, actor_id: event.actor_id,
		purchase_order_id: order, note, occurred_at: event.occurred_at ?? now, recorded_at: now };
	return (await ctx.db.get(await ctx.db.insert('inventory_events', row)))!;
}

/** Add one signed movement and update the projection. Returns the movement ID (the new revision). */
export async function insertMovement(ctx: MutationCtx, event: Doc<'inventory_events'>, product: Doc<'products'>, delta: string): Promise<number> {
	validateQuantity(product, delta, { unbounded: true });
	const sign = compareDecimals(delta, '0');
	if (sign === 0) fail('ZERO_MOVEMENT');
	if ((event.kind === 'receipt' && sign < 0) || ((event.kind === 'sale' || event.kind === 'withdrawal') && sign > 0)) fail('INVALID_MOVEMENT_SIGN');
	const id = await nextSequence(ctx, 'inventory_movements');
	await ctx.db.insert('inventory_movements', { id, event_id: event.id, product_id: product.id, quantity_delta: delta });
	const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', product.id)).unique();
	if (level) await ctx.db.patch(level._id, { quantity: addDecimals(level.quantity, delta), revision: id });
	else await ctx.db.insert('stock_levels', { product_id: product.id, quantity: delta, revision: id, last_counted_at: null });
	return id;
}

/** A count was observed (with or without a movement): it is the product's latest count. */
export async function markCounted(ctx: MutationCtx, productId: string, recordedAt: string) {
	const level = await ctx.db.query('stock_levels').withIndex('product_id', (q) => q.eq('product_id', productId)).unique();
	if (level) await ctx.db.patch(level._id, { last_counted_at: recordedAt });
	else await ctx.db.insert('stock_levels', { product_id: productId, quantity: '0', revision: 0, last_counted_at: recordedAt });
}

export async function movementById(ctx: QueryCtx, id: number) {
	return await ctx.db.query('inventory_movements').withIndex('seq', (q) => q.eq('id', id)).unique();
}

/** Link a correction to the earlier movement it corrects (guard_correction). */
export async function insertCorrection(ctx: MutationCtx, movementId: number, correctsId: number) {
	const movement = await movementById(ctx, movementId);
	const original = await movementById(ctx, correctsId);
	if (!original) fail('CORRECTED_MOVEMENT_NOT_FOUND', String(correctsId));
	const event = movement && await byUuid(ctx, 'inventory_events', movement.event_id);
	if (!movement || !event || movement.product_id !== original.product_id || event.kind !== 'adjustment' || movementId <= correctsId) {
		fail('INVALID_CORRECTION_REFERENCE');
	}
	await ctx.db.insert('movement_corrections', { movement_id: movementId, corrects_movement_id: correctsId });
}

/** Allocate a receipt (or receipt correction) movement to an order line (guard_receipt_allocation). */
export async function insertAllocation(ctx: MutationCtx, movementId: number, lineId: string) {
	const movement = await movementById(ctx, movementId);
	const line = await byUuid(ctx, 'purchase_order_lines', lineId);
	const event = movement && await byUuid(ctx, 'inventory_events', movement.event_id);
	if (!movement || !line || !event || movement.product_id !== line.product_id || !['receipt', 'adjustment'].includes(event.kind)) {
		fail('INVALID_RECEIPT_ALLOCATION');
	}
	await ctx.db.insert('receipt_allocations', { movement_id: movementId, order_line_id: lineId });
}

export type LineProgress = Doc<'purchase_order_lines'> & { received_quantity: string; cancelled_quantity: string; outstanding_quantity: string };
/** received, cancelled and outstanding for one order line (purchase_line_progress). */
export async function lineProgress(ctx: QueryCtx, line: Doc<'purchase_order_lines'>): Promise<LineProgress> {
	const allocations = await ctx.db.query('receipt_allocations').withIndex('order_line_id', (q) => q.eq('order_line_id', line.id)).collect();
	const deltas: string[] = [];
	for (const allocation of allocations) {
		const movement = await movementById(ctx, allocation.movement_id);
		if (movement) deltas.push(movement.quantity_delta);
	}
	const cancellations = await ctx.db.query('purchase_order_cancellations').withIndex('order_line_id', (q) => q.eq('order_line_id', line.id)).collect();
	const received = sumDecimals(deltas);
	const cancelled = sumDecimals(cancellations.map((c) => c.reverses_id === null ? c.quantity : `-${c.quantity}`));
	const remaining = subtractDecimals(subtractDecimals(line.ordered_quantity, received), cancelled);
	return { ...line, received_quantity: received, cancelled_quantity: cancelled, outstanding_quantity: compareDecimals(remaining, '0') > 0 ? remaining : '0' };
}
