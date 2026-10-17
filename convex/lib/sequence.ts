import type { MutationCtx } from '../_generated/server';

/**
 * Monotonic sequences for movement and audit IDs (PostgreSQL identity columns).
 * The counter row serializes writers of one sequence; Convex retries the
 * losing transaction, so IDs are gap-free and ordered by commit.
 */
export async function nextSequence(ctx: MutationCtx, name: 'inventory_movements' | 'audit_log'): Promise<number> {
	const counter = await ctx.db.query('counters').withIndex('name', (q) => q.eq('name', name)).unique();
	const value = (counter?.value ?? 0) + 1;
	if (!Number.isSafeInteger(value)) throw new Error('SEQUENCE_EXHAUSTED');
	if (counter) await ctx.db.patch(counter._id, { value });
	else await ctx.db.insert('counters', { name, value });
	return value;
}
