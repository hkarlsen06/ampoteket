import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { fail } from './errors';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export function newUuid(): string { return crypto.randomUUID(); }

type UuidTable = 'staff_members' | 'help_contacts' | 'categories' | 'cabinets' | 'bins' | 'products' | 'attribute_definitions'
	| 'command_requests' | 'purchase_orders' | 'purchase_order_lines' | 'purchase_order_cancellations' | 'checkouts'
	| 'count_batches' | 'inventory_events';

/** The row with this UUID, or null. Invalid UUIDs find nothing. */
export async function byUuid<T extends UuidTable>(ctx: QueryCtx, table: T, id: string | null | undefined): Promise<Doc<T> | null> {
	if (!isUuid(id)) return null;
	// Every UuidTable has a `uuid` index on `id`; TypeScript cannot prove that for a generic table.
	type ByUuid = { withIndex(name: 'uuid', range: (q: { eq(field: 'id', value: string): unknown }) => unknown): { unique(): Promise<Doc<T> | null> } };
	return await (ctx.db.query(table) as unknown as ByUuid).withIndex('uuid', (q) => q.eq('id', id)).unique();
}
export async function requireUuid<T extends UuidTable>(ctx: QueryCtx, table: T, id: string | null | undefined, code: string): Promise<Doc<T>> {
	return (await byUuid(ctx, table, id)) ?? fail(code, id ?? undefined);
}
