/**
 * Stock adjustments, withdrawals, linked corrections and counts
 * (datamodell.md §5, §8, §10). Each command is one mutation: every check runs
 * before any write, and an error rolls everything back.
 */
import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { Actor } from './lib/audit';
import { insertAudited, patchAudited } from './lib/audit';
import { beginCommand } from './lib/commands';
import { compareDecimals, negateDecimal, subtractDecimals } from './lib/decimal';
import { fail } from './lib/errors';
import { byUuid, newUuid } from './lib/ids';
import { insertAllocation, insertCorrection, insertEvent, insertMovement, lineProgress, markCounted, movementById, requireProduct, stockLevel, validateQuantity } from './lib/inventory';
import { currentStaff, requireStaff } from './lib/staff';
import { isoNow } from './lib/time';

function checkItems<T>(items: T[]): T[] {
	if (items.length < 1 || items.length > 200) fail('INVALID_ITEM_COUNT');
	return items;
}
function checkReason(reason: string, code = 'REASON_REQUIRED'): string {
	if (!reason.trim() || [...reason].length > 2000) fail(code);
	return reason;
}
const manualItem = v.object({
	productId: v.string(), quantity: v.optional(v.string()), quantityDelta: v.optional(v.string()),
	correctsMovementId: v.optional(v.string()), expectedRevision: v.optional(v.string())
});
type ManualItem = typeof manualItem.type;

/** Adjustments and withdrawals (app.post_manual). Returns the event ID. */
async function postManual(ctx: MutationCtx, actor: Actor, requestId: string, kind: 'adjustment' | 'withdrawal', items: ManualItem[], reason: string, recount: boolean) {
	checkReason(reason);
	const command = await beginCommand<{ event_id: string }>(ctx, requestId, kind, actor.staffId, { items, reason, recount });
	if (command.done) return command.result;
	checkItems(items);
	const corrected = items.filter((item) => item.correctsMovementId !== undefined).map((item) => item.correctsMovementId);
	if (new Set(corrected).size !== corrected.length) fail('DUPLICATE_CORRECTION_REFERENCE');
	// Validate every observation before adding any movement from this command.
	for (const item of items) {
		if (item.correctsMovementId === undefined) continue;
		if (item.expectedRevision === undefined) fail('CORRECTION_REVISION_REQUIRED');
		const level = await stockLevel(ctx, item.productId);
		if (String(level.revision) !== item.expectedRevision) fail('STALE_STOCK_CORRECTION');
		const target = Number(item.correctsMovementId);
		if (!recount) {
			const counts = await ctx.db.query('stock_counts').withIndex('product_id', (q) => q.eq('product_id', item.productId)).collect();
			if (counts.some((count) => count.expected_revision >= target)) fail('CORRECTION_REQUIRES_RECOUNT');
		}
	}
	const event = await insertEvent(ctx, { request_id: requestId, kind, actor_id: actor.staffId, note: reason });
	for (const item of items) {
		const product = await requireProduct(ctx, item.productId);
		const original = item.correctsMovementId === undefined ? null : Number(item.correctsMovementId);
		let delta: string;
		if (kind === 'withdrawal') {
			if (item.quantity === undefined || original !== null) fail('INVALID_WITHDRAWAL');
			delta = negateDecimal(validateQuantity(product, item.quantity));
			if (compareDecimals(delta, '0') >= 0) fail('INVALID_WITHDRAWAL');
		} else {
			delta = validateQuantity(product, item.quantityDelta);
		}
		const movementId = await insertMovement(ctx, event, product, delta);
		if (original === null) continue;
		if (!Number.isSafeInteger(original) || original < 1) fail('CORRECTED_MOVEMENT_NOT_FOUND', item.correctsMovementId);
		await insertCorrection(ctx, movementId, original);
		// A receipt correction inherits the receipt's order line, so order progress follows.
		const allocation = await ctx.db.query('receipt_allocations').withIndex('movement_id', (q) => q.eq('movement_id', original)).unique();
		if (!allocation) continue;
		await insertAllocation(ctx, movementId, allocation.order_line_id);
		const line = (await byUuid(ctx, 'purchase_order_lines', allocation.order_line_id))!;
		const progress = await lineProgress(ctx, line);
		if (compareDecimals(progress.received_quantity, '0') < 0
			|| compareDecimals(subtractDecimals(progress.ordered_quantity, progress.received_quantity), progress.cancelled_quantity) < 0) {
			fail('RECEIPT_CORRECTION_OUT_OF_RANGE');
		}
	}
	return await command.finish({ event_id: event.id });
}

export const adjust = mutation({
	args: { requestId: v.string(), items: v.array(manualItem), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		return await postManual(ctx, actor, args.requestId, 'adjustment', args.items, args.reason, false);
	}
});

export const withdraw = mutation({
	args: { requestId: v.string(), items: v.array(v.object({ productId: v.string(), quantity: v.string() })), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		return await postManual(ctx, actor, args.requestId, 'withdrawal', args.items, args.reason, false);
	}
});

type CountResult = { batch_id: string; event_id: string; quantity: string; difference: string };
/** Post one observation into `batch`; the expected value is read in this transaction. */
async function postCount(ctx: MutationCtx, actor: Actor, requestId: string, batch: Doc<'count_batches'>, product: Doc<'products'>,
	expectedRevision: string, counted: string, note: string | null): Promise<CountResult> {
	const quantity = validateQuantity(product, counted, { unbounded: true });
	if (compareDecimals(quantity, '0') < 0) fail('NEGATIVE_PHYSICAL_COUNT');
	const level = await stockLevel(ctx, product.id);
	if (String(level.revision) !== expectedRevision) fail('STALE_STOCK_COUNT');
	const event = await insertEvent(ctx, { request_id: requestId, kind: 'count', actor_id: actor.staffId, note });
	await ctx.db.insert('stock_counts', { event_id: event.id, batch_id: batch.id, product_id: product.id,
		expected_quantity: level.quantity, counted_quantity: quantity, expected_revision: level.revision });
	const difference = subtractDecimals(quantity, level.quantity);
	if (compareDecimals(difference, '0') !== 0) await insertMovement(ctx, event, product, difference);
	await markCounted(ctx, product.id, event.recorded_at);
	return { batch_id: batch.id, event_id: event.id, quantity, difference };
}

function checkNote(note: string | null): string | null {
	if (note !== null && [...note].length > 2000) fail('NOTE_TOO_LONG');
	return note;
}

/** A single-product count is its own batch, born finished, titled with the product code. */
async function singleCount(ctx: MutationCtx, actor: Actor, requestId: string, productId: string, expectedRevision: string, counted: string, note: string | null) {
	const command = await beginCommand<CountResult>(ctx, requestId, 'record_single_count', actor.staffId, { productId, expectedRevision, counted, note });
	if (command.done) return command.result;
	const product = await requireProduct(ctx, productId);
	const now = isoNow();
	const batch = await insertAudited(ctx, actor, 'count_batches', { id: newUuid(), request_id: requestId, owner_id: actor.staffId!, title: product.code,
		started_at: now, finished_at: now, finished_by: actor.staffId, finish_reason: null, product_id: product.id });
	return await command.finish(await postCount(ctx, actor, requestId, batch, product, expectedRevision, counted, checkNote(note)));
}

export const recordSingleCount = mutation({
	args: { requestId: v.string(), productId: v.string(), expectedRevision: v.string(), counted: v.string(), note: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		return await singleCount(ctx, actor, args.requestId, args.productId, args.expectedRevision, args.counted, args.note);
	}
});

/**
 * A later count may already have absorbed the mistake: correct the movement and
 * recount in one transaction. Both child commands keep their own request IDs.
 */
export const correctAndCount = mutation({
	args: { requestId: v.string(), correctsMovementId: v.string(), expectedRevision: v.string(), quantityDelta: v.string(), counted: v.string(), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const command = await beginCommand<{ correction_event_id: string; count_event_id: string; batch_id: string; quantity: string }>(
			ctx, args.requestId, 'correct_movement_and_count', actor.staffId, args);
		if (command.done) return command.result;
		checkReason(args.reason);
		const movement = await movementById(ctx, Number(args.correctsMovementId));
		if (!movement) fail('CORRECTED_MOVEMENT_NOT_FOUND');
		const product = await requireProduct(ctx, movement.product_id);
		if (String((await stockLevel(ctx, product.id)).revision) !== args.expectedRevision) fail('STALE_STOCK_COUNT');
		const counted = validateQuantity(product, args.counted, { unbounded: true });
		if (compareDecimals(counted, '0') < 0) fail('NEGATIVE_PHYSICAL_COUNT');
		const adjustment = await postManual(ctx, actor, newUuid(), 'adjustment', [{ productId: product.id, quantityDelta: args.quantityDelta,
			correctsMovementId: args.correctsMovementId, expectedRevision: args.expectedRevision }], args.reason, true);
		const revision = String((await stockLevel(ctx, product.id)).revision);
		const count = await singleCount(ctx, actor, newUuid(), product.id, revision, counted, args.reason);
		return await command.finish({ correction_event_id: adjustment.event_id, count_event_id: count.event_id, batch_id: count.batch_id, quantity: count.quantity });
	}
});

export const startCountBatch = mutation({
	args: { requestId: v.string(), title: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const command = await beginCommand<{ batch_id: string }>(ctx, args.requestId, 'start_count_batch', actor.staffId, { title: args.title });
		if (command.done) return command.result;
		if (!args.title.trim() || [...args.title.trim()].length > 200) fail('COUNT_TITLE_REQUIRED');
		const batch = await insertAudited(ctx, actor, 'count_batches', { id: newUuid(), request_id: args.requestId, owner_id: actor.staffId!, title: args.title,
			started_at: isoNow(), finished_at: null, finished_by: null, finish_reason: null, product_id: null });
		return await command.finish({ batch_id: batch.id });
	}
});

export const recordCount = mutation({
	args: { requestId: v.string(), batchId: v.string(), productId: v.string(), expectedRevision: v.string(), counted: v.string(), note: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<CountResult>(ctx, requestId, 'record_count', actor.staffId, body);
		if (command.done) return command.result;
		const batch = (await byUuid(ctx, 'count_batches', args.batchId)) ?? fail('COUNT_BATCH_NOT_FOUND');
		if (batch.owner_id !== actor.staffId) fail('COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER');
		if (batch.finished_at !== null) fail('COUNT_BATCH_FINISHED');
		const product = await requireProduct(ctx, args.productId);
		return await command.finish(await postCount(ctx, actor, requestId, batch, product, args.expectedRevision, args.counted, checkNote(args.note)));
	}
});

/** Repeat-safe by batch identity: finishing twice is a no-op. */
export const finishCountBatch = mutation({
	args: { batchId: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const batch = (await byUuid(ctx, 'count_batches', args.batchId)) ?? fail('COUNT_BATCH_NOT_FOUND');
		if (batch.owner_id !== actor.staffId) fail('COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER');
		if (batch.finished_at === null) await patchAudited(ctx, actor, 'count_batches', batch, { finished_at: isoNow(), finished_by: actor.staffId });
		return { batch_id: batch.id, finished: true };
	}
});

/** Another member may close a batch only once its owner is deactivated or has no Auth account. */
export const closeAbandonedCountBatch = mutation({
	args: { requestId: v.string(), batchId: v.string(), reason: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const command = await beginCommand<{ batch_id: string; finished: true }>(ctx, args.requestId, 'close_abandoned_count_batch', actor.staffId, { batchId: args.batchId, reason: args.reason });
		if (command.done) return command.result;
		checkReason(args.reason, 'CLOSURE_REASON_REQUIRED');
		const batch = (await byUuid(ctx, 'count_batches', args.batchId)) ?? fail('COUNT_BATCH_NOT_FOUND');
		if (batch.finished_at === null) {
			const owner = (await byUuid(ctx, 'staff_members', batch.owner_id))!;
			if (owner.is_active && owner.auth_user_id !== null) fail('COUNT_BATCH_OWNER_STILL_ACTIVE');
			await patchAudited(ctx, actor, 'count_batches', batch, { finished_at: isoNow(), finished_by: actor.staffId, finish_reason: args.reason.trim() });
		}
		return await command.finish({ batch_id: batch.id, finished: true });
	}
});

// ---------- Staff reads ----------

/** Quantity, revision and last count for every product (or the listed ones). */
export const inventory = query({
	args: { productIds: v.optional(v.array(v.string())) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const ids = args.productIds ?? (await ctx.db.query('products').collect()).map((p) => p.id);
		return await Promise.all(ids.map((id) => stockLevel(ctx, id)));
	}
});

/** One product's ledger: balance, movements (newest first) with their links, and counts. */
export const detail = query({
	args: { productId: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const product = await requireProduct(ctx, args.productId);
		const stock = await stockLevel(ctx, product.id);
		const movements = await ctx.db.query('inventory_movements').withIndex('product', (q) => q.eq('product_id', product.id)).order('desc').collect();
		const counts = await ctx.db.query('stock_counts').withIndex('product_id', (q) => q.eq('product_id', product.id)).collect();
		const events = new Map<string, Doc<'inventory_events'>>();
		const names = new Map<string, string>();
		async function event(id: string) {
			if (!events.has(id)) events.set(id, (await byUuid(ctx, 'inventory_events', id))!);
			const found = events.get(id)!;
			if (found.actor_id && !names.has(found.actor_id)) names.set(found.actor_id, (await byUuid(ctx, 'staff_members', found.actor_id))?.display_name ?? '');
			return found;
		}
		const actor = (e: Doc<'inventory_events'>) => e.actor_id === null ? null : names.get(e.actor_id) ?? null;
		const rows = [];
		for (const m of movements) {
			const e = await event(m.event_id);
			const correction = await ctx.db.query('movement_corrections').withIndex('movement_id', (q) => q.eq('movement_id', m.id)).unique();
			const allocation = await ctx.db.query('receipt_allocations').withIndex('movement_id', (q) => q.eq('movement_id', m.id)).unique();
			const line = allocation ? await lineProgress(ctx, (await byUuid(ctx, 'purchase_order_lines', allocation.order_line_id))!) : null;
			rows.push({ id: String(m.id), eventId: e.id, delta: m.quantity_delta, kind: e.kind, note: e.note, at: e.recorded_at, actor: actor(e),
				corrects: correction ? String(correction.corrects_movement_id) : null, orderLineId: line?.id ?? null, orderId: line?.order_id ?? null,
				received: line?.received_quantity ?? null, outstanding: line?.outstanding_quantity ?? null });
		}
		const countRows = [];
		for (const c of counts) {
			const e = await event(c.event_id);
			countRows.push({ eventId: e.id, revision: String(c.expected_revision), expected: c.expected_quantity, quantity: c.counted_quantity, at: e.recorded_at, actor: actor(e), note: e.note });
		}
		return { stock: { productId: product.id, quantity: stock.quantity, revision: String(stock.revision), lastCountedAt: stock.last_counted_at }, movements: rows, counts: countRows };
	}
});

/** Grouped count batches (single-product counts live in the product history) and their owners. */
export const countBatches = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		const batches = (await ctx.db.query('count_batches').withIndex('product_id', (q) => q.eq('product_id', null)).collect())
			.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
		const owners = (await ctx.db.query('staff_members').collect()).map((s) => ({ id: s.id, name: s.display_name, active: s.is_active, authUserId: s.auth_user_id }));
		return { batches: batches.map(batchRow), owners };
	}
});

function batchRow(b: Doc<'count_batches'>) {
	return { id: b.id, ownerId: b.owner_id, title: b.title, productId: b.product_id, startedAt: b.started_at,
		finishedAt: b.finished_at, finishedBy: b.finished_by, finishReason: b.finish_reason };
}

/**
 * One batch, its observations (newest first), the people involved and the
 * products the page needs. `productId` adds the product of a count still
 * pending in this browser, so it can be retried or released after the batch closed.
 */
export const countDetail = query({
	args: { batchId: v.string(), productId: v.optional(v.string()) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const viewer = (await currentStaff(ctx))!;
		const batch = await byUuid(ctx, 'count_batches', args.batchId);
		if (!batch) return null;
		const counts = await ctx.db.query('stock_counts').withIndex('batch_id', (q) => q.eq('batch_id', batch.id)).collect();
		const observations = [];
		for (const c of counts) {
			const e = (await byUuid(ctx, 'inventory_events', c.event_id))!;
			observations.push({ eventId: e.id, batchId: batch.id, productId: c.product_id, expected: c.expected_quantity, counted: c.counted_quantity,
				revision: String(c.expected_revision), recordedAt: e.recorded_at, actorId: e.actor_id!, note: e.note });
		}
		observations.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.eventId.localeCompare(a.eventId));
		const ownerIds = new Set([batch.owner_id, ...(batch.finished_by ? [batch.finished_by] : []), ...observations.map((o) => o.actorId)]);
		const owners = [];
		for (const id of ownerIds) {
			const s = await byUuid(ctx, 'staff_members', id);
			if (s) owners.push({ id: s.id, name: s.display_name, active: s.is_active, authUserId: s.auth_user_id });
		}
		// The open batch's owner searches every product; others need only the counted ones.
		const ownerView = batch.finished_at === null && batch.owner_id === viewer.id;
		const products = ownerView ? await ctx.db.query('products').collect()
			: (await Promise.all([...new Set([...observations.map((o) => o.productId), ...(args.productId ? [args.productId] : [])])].map((id) => byUuid(ctx, 'products', id)))).filter((p) => p !== null);
		return { batch: batchRow(batch), owners, observations,
			products: products.map((p) => ({ id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, unit_code: p.unit_code, stock_step: p.stock_step, bin_id: p.bin_id, is_active: p.is_active })) };
	}
});
