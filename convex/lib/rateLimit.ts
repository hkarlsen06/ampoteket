import type { MutationCtx } from '../_generated/server';
import { fail } from './errors';

/** Allow `limit` uses of `key` per fixed window; RATE_LIMITED after that. */
export async function rateLimit(ctx: MutationCtx, key: string, limit: number, windowMs = 60_000) {
	const now = Date.now();
	const row = await ctx.db.query('rate_limits').withIndex('key', (q) => q.eq('key', key)).unique();
	if (!row || now - row.window_start >= windowMs) {
		if (row) await ctx.db.patch(row._id, { window_start: now, count: 1 });
		else await ctx.db.insert('rate_limits', { key, window_start: now, count: 1 });
		return;
	}
	if (row.count >= limit) fail('RATE_LIMITED');
	await ctx.db.patch(row._id, { count: row.count + 1 });
}
