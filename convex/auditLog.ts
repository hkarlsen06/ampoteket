/**
 * The staff change log. Entries come with the names they refer to (staff,
 * products, specifications, drawers and cabinets, including where archived
 * drawers used to be), so the page needs one subscription per page of entries.
 * Checkout contact values never appear in audit images.
 */
import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { archivedBinLocation } from './lib/archivedBins';
import { byUuid, isUuid } from './lib/ids';
import { requireStaff } from './lib/staff';

const PAGE = 200;
const referenceTables: Record<string, 'products' | 'attribute_definitions' | 'categories' | 'bins' | 'cabinets' | 'purchase_orders' | 'staff_members'> = {
	product_id: 'products', attribute_id: 'attribute_definitions', category_id: 'categories', bin_id: 'bins', cabinet_id: 'cabinets',
	order_id: 'purchase_orders', owner_id: 'staff_members', created_by: 'staff_members', finished_by: 'staff_members'
};
type Row = Record<string, unknown>;

function entryRow(a: Doc<'audit_log'>) {
	return { id: String(a.id), table_name: a.table_name, row_key: a.row_key, action: a.action, before_data: a.before_data, after_data: a.after_data,
		actor_id: a.actor_id, database_role: a.database_role, recorded_at: a.recorded_at };
}

function referenceRow(table: string, doc: Row): Row {
	const pick = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, doc[key] ?? null]));
	switch (table) {
		case 'products': return pick('id', 'code', 'name_nb', 'name_en', 'unit_code');
		case 'attribute_definitions': return pick('id', 'code', 'label', 'value_type', 'canonical_unit');
		case 'categories': return pick('id', 'name');
		case 'bins': return pick('id', 'label', 'inner_row', 'inner_col', 'row_span', 'col_span', 'cabinet_id');
		case 'cabinets': return pick('id', 'label', 'outer_row', 'outer_col');
		case 'purchase_orders': return pick('id', 'supplier_name', 'supplier_reference');
		default: return pick('id', 'display_name');
	}
}

/** The current rows (names only) that these entries refer to, by table and UUID. */
async function references(ctx: QueryCtx, entries: Doc<'audit_log'>[], actorsOnly = false) {
	const wanted = new Map<string, Set<string>>();
	const want = (table: string, id: unknown) => { if (isUuid(id)) wanted.set(table, (wanted.get(table) ?? new Set()).add(id)); };
	for (const entry of entries) {
		want('staff_members', entry.actor_id);
		if (actorsOnly) continue;
		for (const row of [entry.before_data, entry.after_data] as (Row | null)[]) {
			if (row) for (const [field, table] of Object.entries(referenceTables)) want(table, row[field]);
		}
	}
	const result: Record<string, Record<string, Row>> = {};
	for (const [table, ids] of wanted) {
		result[table] = {};
		for (const id of ids) {
			const doc = await byUuid(ctx, table as 'products', id);
			if (doc) result[table][id] = referenceRow(table, doc as unknown as Row);
		}
	}
	// An archived drawer has lost its coordinates; its former place comes from its archive.
	for (const [id, bin] of Object.entries(result.bins ?? {})) {
		if (bin.inner_row !== null) continue;
		const location = await archivedBinLocation(ctx, id);
		if (location) result.bins[id] = { ...bin, cabinet_id: location.cabinet_id, inner_row: location.inner_row, inner_col: location.inner_col,
			row_span: location.row_span, col_span: location.col_span,
			archived_cabinet: { label: location.cabinet_label, outer_row: location.cabinet_outer_row, outer_col: location.cabinet_outer_col } };
	}
	for (const bin of Object.values(result.bins ?? {})) {
		const id = bin.cabinet_id;
		if (!isUuid(id) || result.cabinets?.[id]) continue;
		const cabinet = await byUuid(ctx, 'cabinets', id);
		if (cabinet) (result.cabinets ??= {})[id] = referenceRow('cabinets', cabinet as unknown as Row);
	}
	return result;
}

/** 200 entries, newest first, older than `before` (an entry ID) when given. */
export const page = query({
	args: { before: v.optional(v.string()) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const before = args.before === undefined ? undefined : Number(args.before);
		const rows = await ctx.db.query('audit_log').withIndex('seq', (q) => before === undefined ? q : q.lt('id', before)).order('desc').take(PAGE + 1);
		const entries = rows.slice(0, PAGE);
		return { entries: entries.map(entryRow), references: await references(ctx, entries), more: rows.length > PAGE };
	}
});

/** Every product creation since `since`, newest first, with who created it. */
export const productCreations = query({
	args: { since: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const since = new Date(Date.parse(args.since)).toISOString().replace(/Z$/, '000Z');
		const entries = (await ctx.db.query('audit_log').withIndex('table_action', (q) => q.eq('table_name', 'products').eq('action', 'INSERT')).order('desc').collect())
			.filter((entry) => entry.recorded_at >= since);
		return { entries: entries.map(entryRow), references: await references(ctx, entries, true) };
	}
});
