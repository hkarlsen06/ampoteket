/**
 * Cabinets and drawers on the shelf wall (datamodell.md §10 "Shelf layouts and
 * storage", Appendix A `cabinets`/`bins`). Row 1 is the bottom, column 1 the left.
 *
 * Placement rules that were triggers in PostgreSQL are checked here before
 * every write: a live drawer fits its live cabinet and overlaps no other live
 * drawer; live cabinets have distinct positions; storage holding products is
 * never removed, moved or shrunk by a layout; archiving frees the position and
 * the audit keeps where it was.
 */
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { image, insertAudited, patchAudited, type Actor } from './lib/audit';
import { beginCommand } from './lib/commands';
import { fail } from './lib/errors';
import { archivedBinLocation } from './lib/archivedBins';
import { byUuid, isUuid } from './lib/ids';
import { requireStaff } from './lib/staff';

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const cabinetValue = v.object({ id: v.string(), code: v.string(), label: nullableString, outer_row: nullableNumber, outer_col: nullableNumber,
	inner_rows: v.number(), inner_cols: v.number(), is_archived: v.boolean() });
const binValue = v.object({ id: v.string(), code: v.string(), label: nullableString, cabinet_id: nullableString, inner_row: nullableNumber,
	inner_col: nullableNumber, row_span: v.number(), col_span: v.number(), is_archived: v.boolean() });
type CabinetValue = typeof cabinetValue.type;
type BinValue = typeof binValue.type;
type Rect = { inner_row: number; inner_col: number; row_span: number; col_span: number };

const MAX_INT = 2147483647;
const coordinate = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= 1 && value <= MAX_INT;
const overlaps = (a: Rect, b: Rect) => a.inner_row < b.inner_row + b.row_span && b.inner_row < a.inner_row + a.row_span
	&& a.inner_col < b.inner_col + b.col_span && b.inner_col < a.inner_col + a.col_span;
const fits = (bin: Rect, cabinet: { inner_rows: number; inner_cols: number }) =>
	bin.inner_row + bin.row_span - 1 <= cabinet.inner_rows && bin.inner_col + bin.col_span - 1 <= cabinet.inner_cols;
/** Field-by-field equality of a stored row and a submitted snapshot. */
function sameRow(doc: Doc<'cabinets'> | Doc<'bins'>, value: CabinetValue | BinValue): boolean {
	const row = image(doc) as Record<string, unknown>;
	const keys = new Set([...Object.keys(row), ...Object.keys(value)]);
	return [...keys].every((key) => row[key] === (value as Record<string, unknown>)[key]);
}

async function liveBins(ctx: QueryCtx, cabinetId: string) {
	return (await ctx.db.query('bins').withIndex('cabinet_id', (q) => q.eq('cabinet_id', cabinetId)).collect()).filter((b) => !b.is_archived);
}
async function hasProducts(ctx: QueryCtx, binId: string) {
	return (await ctx.db.query('products').withIndex('bin_id', (q) => q.eq('bin_id', binId)).first()) !== null;
}
async function checkCabinetPosition(ctx: QueryCtx, cabinet: { id: string; outer_row: number | null; outer_col: number | null }) {
	const other = await ctx.db.query('cabinets').withIndex('position', (q) => q.eq('outer_row', cabinet.outer_row).eq('outer_col', cabinet.outer_col)).first();
	if (other && other.id !== cabinet.id) fail('CABINET_POSITION_OCCUPIED');
}
/** check_bin_placement: the drawer fits a live cabinet and overlaps no other live drawer. */
async function checkBinPlacement(ctx: QueryCtx, bin: { id: string; cabinet_id: string | null } & Rect, ignore: string[] = []) {
	const cabinet = (await byUuid(ctx, 'cabinets', bin.cabinet_id)) ?? fail('CABINET_NOT_FOUND');
	if (cabinet.is_archived) fail('CABINET_ARCHIVED');
	if (!fits(bin, cabinet)) fail('BIN_DOES_NOT_FIT_CABINET_GRID');
	for (const other of await liveBins(ctx, cabinet.id)) {
		if (other.id !== bin.id && !ignore.includes(other.id) && overlaps(bin, other as Rect)) fail('BIN_POSITION_OCCUPIED');
	}
}
async function codeTaken(ctx: QueryCtx, table: 'cabinets' | 'bins', code: string, id: string) {
	const other = await ctx.db.query(table).withIndex('code', (q) => q.eq('code', code)).first();
	return other !== null && other.id !== id;
}
function validStorage(value: CabinetValue | BinValue): boolean {
	return isUuid(value.id) && value.code.trim().length >= 1 && [...value.code.trim()].length <= 64 && value.is_archived === false;
}

/** Retire a drawer: no products may be assigned; its position is freed. */
async function archiveBin(ctx: MutationCtx, actor: Actor, bin: Doc<'bins'>) {
	if (await hasProducts(ctx, bin.id)) fail('BIN_STILL_HAS_PRODUCTS');
	await patchAudited(ctx, actor, 'bins', bin, { is_archived: true, cabinet_id: null, inner_row: null, inner_col: null });
}

/**
 * Save one cabinet and its complete drawer layout. `before`/`beforeBins` are
 * the exact rows the editor started from (null/empty for a new cabinet); any
 * intervening change raises STALE_SHELF_LAYOUT. Omitted drawers are archived.
 */
export const saveLayout = mutation({
	args: { requestId: v.string(), before: v.union(cabinetValue, v.null()), cabinet: cabinetValue, beforeBins: v.array(binValue), bins: v.array(binValue) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ cabinet_id: string; saved: true }>(ctx, requestId, 'save_shelf_layout', actor.staffId, body);
		if (command.done) return command.result;
		const { cabinet, bins } = args;
		if (args.beforeBins.length > 4096 || bins.length > 4096 || !validStorage(cabinet)
			|| ![cabinet.outer_row, cabinet.outer_col, cabinet.inner_rows, cabinet.inner_cols].every(coordinate)
			|| cabinet.inner_rows * cabinet.inner_cols > 4096) fail('INVALID_SHELF_LAYOUT');
		for (const bin of bins) {
			if (!validStorage(bin) || bin.cabinet_id !== cabinet.id || ![bin.inner_row, bin.inner_col, bin.row_span, bin.col_span].every(coordinate)
				|| !fits(bin as Rect, cabinet)) fail('INVALID_SHELF_LAYOUT');
		}
		if (new Set(bins.map((b) => b.id)).size !== bins.length || new Set(bins.map((b) => b.code)).size !== bins.length
			|| bins.some((a, i) => bins.some((b, j) => i < j && overlaps(a as Rect, b as Rect)))) fail('INVALID_SHELF_LAYOUT');

		const current = await byUuid(ctx, 'cabinets', cabinet.id);
		if (args.before === null) {
			if (current || args.beforeBins.length) fail('STALE_SHELF_LAYOUT');
		} else if (!current || !sameRow(current, args.before) || args.before.id !== cabinet.id || args.before.code !== cabinet.code) {
			fail('STALE_SHELF_LAYOUT');
		}
		const live = current ? await liveBins(ctx, current.id) : [];
		if (live.length !== args.beforeBins.length || live.some((b) => {
			const shown = args.beforeBins.find((x) => x.id === b.id);
			return !shown || !sameRow(b, shown);
		})) fail('STALE_SHELF_LAYOUT');

		const desired = new Map(bins.map((b) => [b.id, b]));
		for (const bin of bins) {
			const stored = await byUuid(ctx, 'bins', bin.id);
			if (stored && (stored.cabinet_id !== cabinet.id || stored.is_archived || stored.code !== bin.code)) fail('INVALID_SHELF_LAYOUT');
			if (!stored && await codeTaken(ctx, 'bins', bin.code, bin.id)) fail('INVALID_SHELF_LAYOUT');
		}
		const occupied = new Set<string>();
		for (const bin of live) if (await hasProducts(ctx, bin.id)) occupied.add(bin.id);
		for (const bin of live) {
			const next = desired.get(bin.id);
			if (occupied.has(bin.id) && (!next || next.inner_row !== bin.inner_row || next.inner_col !== bin.inner_col
				|| next.row_span < bin.row_span || next.col_span < bin.col_span)) fail('LAYOUT_HAS_PRODUCTS');
		}
		// An occupied drawer may grow at its anchor only over whole neighbours that the layout removes.
		for (const bin of live) {
			const next = desired.get(bin.id);
			if (!next || !occupied.has(bin.id) || (next.row_span === bin.row_span && next.col_span === bin.col_span)) continue;
			for (const neighbour of live) {
				if (neighbour.id === bin.id || !overlaps(next as Rect, neighbour as Rect)) continue;
				const n = neighbour as Rect, r = next as Rect;
				if (n.inner_row < r.inner_row || n.inner_col < r.inner_col || n.inner_row + n.row_span > r.inner_row + r.row_span
					|| n.inner_col + n.col_span > r.inner_col + r.col_span || desired.has(neighbour.id)) fail('INVALID_SHELF_LAYOUT');
			}
		}

		const values = { code: cabinet.code, label: cabinet.label, outer_row: cabinet.outer_row, outer_col: cabinet.outer_col,
			inner_rows: cabinet.inner_rows, inner_cols: cabinet.inner_cols, is_archived: false };
		await checkCabinetPosition(ctx, cabinet);
		if (!current) {
			if (await codeTaken(ctx, 'cabinets', cabinet.code, cabinet.id)) fail('INVALID_SHELF_LAYOUT');
			await insertAudited(ctx, actor, 'cabinets', { id: cabinet.id, ...values });
		} else await patchAudited(ctx, actor, 'cabinets', current, values);
		for (const bin of live) if (!desired.has(bin.id)) await archiveBin(ctx, actor, bin);
		for (const bin of bins) {
			const stored = live.find((b) => b.id === bin.id);
			const placement = { inner_row: bin.inner_row, inner_col: bin.inner_col, row_span: bin.row_span, col_span: bin.col_span, label: bin.label };
			if (stored) await patchAudited(ctx, actor, 'bins', stored, placement);
			else await insertAudited(ctx, actor, 'bins', { id: bin.id, code: bin.code, cabinet_id: cabinet.id, is_archived: false, ...placement });
		}
		return await command.finish({ cabinet_id: cabinet.id, saved: true });
	}
});

/** Retire an empty cabinet and all its (empty) drawers at once. */
export const archiveCabinet = mutation({
	args: { requestId: v.string(), before: cabinetValue, beforeBins: v.array(binValue) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, ...body } = args;
		const command = await beginCommand<{ cabinet_id: string; archived_bins: number }>(ctx, requestId, 'archive_empty_cabinet', actor.staffId, body);
		if (command.done) return command.result;
		const current = await byUuid(ctx, 'cabinets', args.before.id);
		if (!current || current.is_archived || !sameRow(current, args.before)) fail('STALE_SHELF_LAYOUT');
		const live = await liveBins(ctx, current.id);
		if (live.length !== args.beforeBins.length || live.some((b) => {
			const shown = args.beforeBins.find((x) => x.id === b.id);
			return !shown || !sameRow(b, shown);
		})) fail('STALE_SHELF_LAYOUT');
		for (const bin of live) await archiveBin(ctx, actor, bin);
		await patchAudited(ctx, actor, 'cabinets', current, { is_archived: true, outer_row: null, outer_col: null });
		return await command.finish({ cabinet_id: current.id, archived_bins: live.length });
	}
});

/**
 * Move or relabel one cabinet into free space (or archive an empty one).
 * `before` is the row as shown: 'stale' when it changed meanwhile.
 */
export const updateCabinet = mutation({
	args: { before: cabinetValue, after: cabinetValue },
	handler: async (ctx, { before, after }) => {
		const { actor } = await requireStaff(ctx);
		const current = await byUuid(ctx, 'cabinets', after.id);
		if (current && sameRow(current, after)) return 'saved' as const;
		if (!current || !sameRow(current, before)) return 'stale' as const;
		if (after.id !== before.id || after.code !== before.code) fail('STORAGE_IDENTITY_IS_IMMUTABLE');
		if (after.inner_rows !== current.inner_rows || after.inner_cols !== current.inner_cols) fail('INVALID_SHELF_LAYOUT');
		if (after.is_archived) {
			if ((await liveBins(ctx, current.id)).length) fail('CABINET_STILL_HAS_BINS');
			await patchAudited(ctx, actor, 'cabinets', current, { is_archived: true, outer_row: null, outer_col: null, label: after.label });
			return 'saved' as const;
		}
		if (!coordinate(after.outer_row) || !coordinate(after.outer_col)) fail('INVALID_SHELF_LAYOUT');
		await checkCabinetPosition(ctx, after);
		await patchAudited(ctx, actor, 'cabinets', current, { outer_row: after.outer_row, outer_col: after.outer_col, label: after.label, is_archived: false });
		return 'saved' as const;
	}
});

/** Move or relabel one drawer into free cells (or archive an empty one). Spans belong to the layout editor. */
export const updateBin = mutation({
	args: { before: binValue, after: binValue },
	handler: async (ctx, { before, after }) => {
		const { actor } = await requireStaff(ctx);
		const current = await byUuid(ctx, 'bins', after.id);
		if (current && sameRow(current, after)) return 'saved' as const;
		if (!current || !sameRow(current, before)) return 'stale' as const;
		if (after.id !== before.id || after.code !== before.code) fail('STORAGE_IDENTITY_IS_IMMUTABLE');
		// Spans change only through the layout editor (saveLayout), which guards occupied drawers.
		if (after.row_span !== current.row_span || after.col_span !== current.col_span) fail('INVALID_SHELF_LAYOUT');
		if (after.is_archived) { await archiveBin(ctx, actor, current); return 'saved' as const; }
		if (!coordinate(after.inner_row) || !coordinate(after.inner_col) || !isUuid(after.cabinet_id)) fail('INVALID_SHELF_LAYOUT');
		await checkBinPlacement(ctx, after as BinValue & Rect);
		await patchAudited(ctx, actor, 'bins', current, { cabinet_id: after.cabinet_id, inner_row: after.inner_row, inner_col: after.inner_col, label: after.label, is_archived: false });
		return 'saved' as const;
	}
});

/** Exchange two occupied drawer positions; spans travel with the drawers. */
export const swapBins = mutation({
	args: { requestId: v.string(), first: binValue, second: binValue },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, first, second } = args;
		type Result = { first_bin_id: string; first_cabinet_id: string; first_inner_row: number; first_inner_col: number;
			second_bin_id: string; second_cabinet_id: string; second_inner_row: number; second_inner_col: number };
		const command = await beginCommand<Result>(ctx, requestId, 'swap_bins', actor.staffId, { first, second });
		if (command.done) return command.result;
		if (first.id === second.id) fail('TWO_DISTINCT_BINS_AND_POSITIONS_REQUIRED');
		const a = await byUuid(ctx, 'bins', first.id), b = await byUuid(ctx, 'bins', second.id);
		if (!a || !b) fail('BIN_NOT_FOUND');
		if (a.is_archived || b.is_archived) fail('BIN_ARCHIVED');
		const shown = (row: Doc<'bins'>, value: BinValue) => row.cabinet_id === value.cabinet_id && row.inner_row === value.inner_row
			&& row.inner_col === value.inner_col && row.row_span === value.row_span && row.col_span === value.col_span;
		if (!shown(a, first) || !shown(b, second)) fail('STALE_BIN_POSITION');
		const nextA = { ...image(a), cabinet_id: b.cabinet_id, inner_row: b.inner_row!, inner_col: b.inner_col! };
		const nextB = { ...image(b), cabinet_id: a.cabinet_id, inner_row: a.inner_row!, inner_col: a.inner_col! };
		await checkBinPlacement(ctx, nextA, [b.id]);
		await checkBinPlacement(ctx, nextB, [a.id]);
		if (nextA.cabinet_id === nextB.cabinet_id && overlaps(nextA, nextB)) fail('BIN_POSITION_OCCUPIED');
		await patchAudited(ctx, actor, 'bins', a, { cabinet_id: nextA.cabinet_id, inner_row: nextA.inner_row, inner_col: nextA.inner_col });
		await patchAudited(ctx, actor, 'bins', b, { cabinet_id: nextB.cabinet_id, inner_row: nextB.inner_row, inner_col: nextB.inner_col });
		return await command.finish({ first_bin_id: a.id, first_cabinet_id: b.cabinet_id!, first_inner_row: b.inner_row!, first_inner_col: b.inner_col!,
			second_bin_id: b.id, second_cabinet_id: a.cabinet_id!, second_inner_row: a.inner_row!, second_inner_col: a.inner_col! });
	}
});

/** Exchange two cabinet positions on the wall. */
export const swapCabinets = mutation({
	args: { requestId: v.string(), first: cabinetValue, second: cabinetValue },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const { requestId, first, second } = args;
		type Result = { first_cabinet_id: string; first_outer_row: number; first_outer_col: number; second_cabinet_id: string; second_outer_row: number; second_outer_col: number };
		const command = await beginCommand<Result>(ctx, requestId, 'swap_cabinets', actor.staffId, { first, second });
		if (command.done) return command.result;
		if (first.id === second.id) fail('TWO_DISTINCT_CABINETS_AND_POSITIONS_REQUIRED');
		const a = await byUuid(ctx, 'cabinets', first.id), b = await byUuid(ctx, 'cabinets', second.id);
		if (!a || !b) fail('CABINET_NOT_FOUND');
		if (a.is_archived || b.is_archived) fail('CABINET_ARCHIVED');
		if (a.outer_row !== first.outer_row || a.outer_col !== first.outer_col || b.outer_row !== second.outer_row || b.outer_col !== second.outer_col) fail('STALE_CABINET_POSITION');
		await patchAudited(ctx, actor, 'cabinets', a, { outer_row: b.outer_row, outer_col: b.outer_col });
		await patchAudited(ctx, actor, 'cabinets', b, { outer_row: a.outer_row, outer_col: a.outer_col });
		return await command.finish({ first_cabinet_id: a.id, first_outer_row: b.outer_row!, first_outer_col: b.outer_col!,
			second_cabinet_id: b.id, second_outer_row: a.outer_row!, second_outer_col: a.outer_col! });
	}
});

// ---------- Staff reads ----------

/** Every cabinet and drawer (archived too) and every product's drawer assignment. */
export const admin = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		return {
			cabinets: (await ctx.db.query('cabinets').collect()).map((c) => image(c)),
			bins: (await ctx.db.query('bins').collect()).map((b) => image(b)),
			products: (await ctx.db.query('products').collect()).map((p) => ({ id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, bin_id: p.bin_id, is_active: p.is_active }))
		};
	}
});

/** Where archived drawers used to be (amp_archived_bin_locations). */
export const archivedBinLocations = query({
	args: { binIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		return (await Promise.all(args.binIds.map((id) => archivedBinLocation(ctx, id)))).filter((row) => row !== null);
	}
});
