/**
 * Base data for a fresh development or test deployment (production gets its
 * data from the Supabase import instead). Internal: run with
 * `bunx convex run seed:base` and `bunx convex run seed:staff '{...}'`.
 */
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { hashPassword } from './auth';
import { insertAudited, SYSTEM } from './lib/audit';
import { newUuid } from './lib/ids';
import { isoNow } from './lib/time';

const hex = (value: number, width = 12) => value.toString(16).padStart(width, '0');

/**
 * Units and the workshop wall from the initial migration (`Bok.xlsx`): 12
 * cabinets in two rows of six, 492 drawers, the same deterministic IDs. C2 has
 * a full-width drawer at A1–D1 and a two-column drawer at C2–D2. No products,
 * staff or stock. Refuses a deployment that already has cabinets.
 */
export const base = internalMutation({
	args: {},
	handler: async (ctx) => {
		if (await ctx.db.query('cabinets').first()) throw new Error('SEED_TARGET_NOT_EMPTY');
		for (const unit of [{ code: 'pcs', name: 'Piece', symbol: 'stk', is_discrete: true }, { code: 'm', name: 'Metre', symbol: 'm', is_discrete: false },
			{ code: 'g', name: 'Gram', symbol: 'g', is_discrete: false }]) {
			if (!await ctx.db.query('units').withIndex('code', (q) => q.eq('code', unit.code)).unique()) await ctx.db.insert('units', unit);
		}
		const layout = [[1, 1, 12, 4], [1, 2, 12, 4], [1, 3, 12, 4], [1, 4, 12, 4], [1, 5, 8, 3], [1, 6, 8, 3],
			[2, 1, 8, 3], [2, 2, 12, 4], [2, 3, 10, 4], [2, 4, 12, 4], [2, 5, 12, 4], [2, 6, 12, 4]];
		let drawers = 0;
		for (const [outer_row, outer_col, inner_rows, inner_cols] of layout) {
			const index = outer_col + 6 * (outer_row - 1);
			const id = `a0000001-0000-4000-8000-${hex(index)}`;
			await ctx.db.insert('cabinets', { id, code: `C-${id}`, outer_row, outer_col, inner_rows, inner_cols, label: null, is_archived: false });
			const c2 = outer_row === 2 && outer_col === 3;
			for (let r = 1; r <= inner_rows; r++) for (let c = 1; c <= inner_cols; c++) {
				if (c2 && ((r === 1 && c > 1) || (r === 2 && c === 4))) continue;
				const binId = `a0000002-0000-4000-8000-${hex((index - 1) * 1000 + (r - 1) * 10 + c)}`;
				const col_span = c2 && r === 1 && c === 1 ? 4 : c2 && r === 2 && c === 3 ? 2 : 1;
				await ctx.db.insert('bins', { id: binId, code: `B-${binId}`, cabinet_id: id, inner_row: r, inner_col: c, row_span: 1, col_span, label: null, is_archived: false });
				drawers++;
			}
		}
		return { cabinets: layout.length, drawers };
	}
});

/** A staff member who can sign in with this password (development and tests only). */
export const staff = internalMutation({
	args: { email: v.string(), password: v.string(), displayName: v.string(), active: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		const authUserId = newUuid();
		const userId = await ctx.db.insert('users', { email, auth_user_id: authUserId, emailVerificationTime: Date.now() });
		await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email, secret: hashPassword(args.password) });
		const member = await insertAudited(ctx, SYSTEM, 'staff_members', { id: newUuid(), auth_user_id: authUserId, display_name: args.displayName,
			is_active: args.active ?? true, created_at: isoNow() });
		return { staffId: member.id, authUserId };
	}
});
