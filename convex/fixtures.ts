/**
 * Test-only data access for the disposable deployments started by
 * scripts/test-convex.sh and scripts/test-web.sh. Internal (admin key only), and
 * refused unless the deployment sets ALLOW_TEST_FIXTURES=true, which production
 * never does. Writes here bypass the audit on purpose: fixtures are not staff work.
 */
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { TableNames } from './_generated/dataModel';
import { image } from './lib/audit';
import { hashPassword } from './auth';
import { newUuid } from './lib/ids';

function allowed() {
	if (process.env.ALLOW_TEST_FIXTURES !== 'true') throw new Error('TEST_FIXTURES_FORBIDDEN');
}
const matches = (doc: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, value]) => doc[k] === value);

export const insert = internalMutation({
	args: { table: v.string(), rows: v.array(v.any()) },
	handler: async (ctx, { table, rows }) => {
		allowed();
		for (const row of rows) await ctx.db.insert(table as TableNames, row);
		return rows.length;
	}
});

/** Rows of a table (without system fields), optionally only those whose fields equal `where`. */
export const rows = internalQuery({
	args: { table: v.string(), where: v.optional(v.any()) },
	handler: async (ctx, { table, where }) => {
		allowed();
		return (await ctx.db.query(table as TableNames).collect()).map((doc) => image(doc as Record<string, unknown>))
			.filter((doc) => !where || matches(doc, where));
	}
});

/** Patch every row matching `where`; returns how many changed. */
export const patch = internalMutation({
	args: { table: v.string(), where: v.any(), changes: v.any() },
	handler: async (ctx, { table, where, changes }) => {
		allowed();
		let count = 0;
		for (const doc of await ctx.db.query(table as TableNames).collect()) {
			if (!matches(doc as Record<string, unknown>, where)) continue;
			await ctx.db.patch(doc._id, changes); count++;
		}
		return count;
	}
});

/** Delete every row matching `where` (fixture cleanup); returns how many. */
export const remove = internalMutation({
	args: { table: v.string(), where: v.any() },
	handler: async (ctx, { table, where }) => {
		allowed();
		let count = 0;
		for (const doc of await ctx.db.query(table as TableNames).collect()) {
			if (!matches(doc as Record<string, unknown>, where)) continue;
			await ctx.db.delete(doc._id); count++;
		}
		return count;
	}
});

/** An Auth account without staff membership (a signed-in non-staff user). */
export const user = internalMutation({
	args: { email: v.string(), password: v.string() },
	handler: async (ctx, args) => {
		allowed();
		const email = args.email.trim().toLowerCase(), authUserId = newUuid();
		const userId = await ctx.db.insert('users', { email, auth_user_id: authUserId, emailVerificationTime: Date.now() });
		await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: email, secret: hashPassword(args.password) });
		return { authUserId };
	}
});
