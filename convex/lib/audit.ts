/**
 * Audited writes for master data, replacing the `audit_metadata` trigger.
 *
 * Every insert, update and delete on the tables in `AUDITED` must go through
 * these helpers, which write the row and its before/after image to `audit_log`
 * in the same transaction. tests/audit-coverage.test.ts fails if code
 * elsewhere writes these tables directly.
 */
import type { MutationCtx } from '../_generated/server';
import type { Doc, TableNames } from '../_generated/dataModel';
import { nextSequence } from './sequence';
import { isoNow } from './time';

export const AUDITED = ['staff_members', 'help_contacts', 'units', 'categories', 'cabinets', 'bins', 'products',
	'attribute_definitions', 'product_attributes', 'purchase_orders', 'purchase_order_lines', 'count_batches'] as const;
export type AuditedTable = (typeof AUDITED)[number];

/** Who performed a write: a staff member, or a role without one (`convex` for maintenance). */
export type Actor = { staffId: string | null; role: 'authenticated' | 'service_role' | 'convex' };
export const SYSTEM: Actor = { staffId: null, role: 'convex' };

type Row = Record<string, unknown>;
/** The row as the audit and clients see it, without Convex system fields. */
export function image<T extends Row>(doc: T): Omit<T, '_id' | '_creationTime'> {
	const { _id, _creationTime, ...row } = doc as T & { _id?: unknown; _creationTime?: unknown };
	return row;
}
function rowKey(table: AuditedTable, row: Row): Row {
	if (table === 'product_attributes') return { product_id: row.product_id, attribute_id: row.attribute_id };
	if (table === 'units') return { code: row.code };
	return { id: row.id };
}
function same(a: Row, b: Row): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

export async function recordAudit(ctx: MutationCtx, actor: Actor, entry: {
	table: string; key: Row; action: Doc<'audit_log'>['action']; before: Row | null; after: Row | null;
}) {
	await ctx.db.insert('audit_log', {
		id: await nextSequence(ctx, 'audit_log'), table_name: entry.table, row_key: entry.key, action: entry.action,
		before_data: entry.before, after_data: entry.after, actor_id: actor.staffId, database_role: actor.role,
		recorded_at: isoNow(), row_id: typeof entry.key.id === 'string' ? entry.key.id : null
	});
}

export async function insertAudited<T extends AuditedTable & TableNames>(ctx: MutationCtx, actor: Actor, table: T,
	row: Omit<Doc<T>, '_id' | '_creationTime'>): Promise<Doc<T>> {
	// The cast is the one place generic table typing needs help; callers stay typed.
	const _id = await ctx.db.insert(table, row as never);
	await recordAudit(ctx, actor, { table, key: rowKey(table, row), action: 'INSERT', before: null, after: row });
	return (await ctx.db.get(_id))!;
}

/** Patch and audit; a patch that changes nothing writes nothing, like the trigger. */
export async function patchAudited<T extends AuditedTable & TableNames>(ctx: MutationCtx, actor: Actor, table: T,
	doc: Doc<T>, changes: Partial<Omit<Doc<T>, '_id' | '_creationTime'>>): Promise<Doc<T>> {
	const before = image(doc as Row);
	const after = { ...before, ...changes };
	if (same(before, after)) return doc;
	await ctx.db.patch(doc._id, changes as never);
	await recordAudit(ctx, actor, { table, key: rowKey(table, after), action: 'UPDATE', before, after });
	return (await ctx.db.get(doc._id))!;
}

/** Only specification values may be deleted; every other table keeps its records. */
export async function deleteAudited(ctx: MutationCtx, actor: Actor, doc: Doc<'product_attributes'>) {
	const before = image(doc);
	await ctx.db.delete(doc._id);
	await recordAudit(ctx, actor, { table: 'product_attributes', key: rowKey('product_attributes', before), action: 'DELETE', before, after: null });
}
