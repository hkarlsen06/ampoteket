/**
 * Single-use links that set a password: invitations (7 days) and resets (1 hour).
 * Tokens are generated in actions, which have real randomness, and only their
 * SHA-256 is stored. Opening a link consumes nothing; setting the password does.
 */
import { v } from 'convex/values';
import { action, internalMutation, mutation, query, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth';
import { sha256Hex } from './lib/commands';
import { passwordLink, sendPasswordEmail } from './lib/email';
import { fail } from './lib/errors';
import { rateLimit } from './lib/rateLimit';

const HOUR = 3_600_000;
const tokenPattern = /^[a-f0-9]{64}$/;

export async function newToken(): Promise<{ token: string; digest: string }> {
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
	return { token, digest: await sha256Hex(token) };
}

/** A new link replaces the user's earlier unused links. */
export const storeToken = internalMutation({
	args: { userId: v.id('users'), digest: v.string(), purpose: v.union(v.literal('invite'), v.literal('reset')), ttlMs: v.number() },
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const old of await ctx.db.query('password_tokens').withIndex('user_id', (q) => q.eq('user_id', args.userId)).collect()) {
			if (old.used_at === null) await ctx.db.patch(old._id, { used_at: now });
		}
		await ctx.db.insert('password_tokens', { user_id: args.userId, token_digest: args.digest, purpose: args.purpose, expires_at: now + args.ttlMs, used_at: null });
	}
});

/** Rate-limited lookup for a reset request: the user, or null for an unknown address. */
export const resetTarget = internalMutation({
	args: { email: v.string() },
	handler: async (ctx, { email }) => {
		await rateLimit(ctx, 'reset:all', 20);
		await rateLimit(ctx, `reset:${email}`, 1);
		const user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).unique();
		return user?._id ?? null;
	}
});

/**
 * Email a reset link. The answer is the same whether or not the address has an
 * account, so it cannot be used to discover staff addresses.
 */
export const requestReset = action({
	args: { email: v.string(), locale: v.union(v.literal('nb'), v.literal('en')) },
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		if (!email || email.length > 254) fail('INVALID_EMAIL');
		const userId = await ctx.runMutation(internal.passwords.resetTarget, { email });
		if (userId) {
			const { token, digest } = await newToken();
			await ctx.runMutation(internal.passwords.storeToken, { userId, digest, purpose: 'reset', ttlMs: HOUR });
			await sendPasswordEmail('recovery', email, passwordLink(args.locale, token, 'recovery'));
		}
		return null;
	}
});

async function liveToken(ctx: QueryCtx, token: string) {
	if (!tokenPattern.test(token)) return null;
	const digest = await sha256Hex(token);
	const row = await ctx.db.query('password_tokens').withIndex('token_digest', (q) => q.eq('token_digest', digest)).unique();
	return row && row.used_at === null && row.expires_at > Date.now() ? row : null;
}

/** Whether a link can still set a password (shown before the form). */
export const checkLink = query({
	args: { token: v.string() },
	handler: async (ctx, args) => ({ valid: (await liveToken(ctx, args.token)) !== null })
});

/**
 * Set the password and consume the link. Returns the account email, so the
 * page can sign in with the new password straight away.
 */
export const complete = mutation({
	args: { token: v.string(), password: v.string() },
	handler: async (ctx, args) => {
		const link = (await liveToken(ctx, args.token)) ?? fail('INVALID_PASSWORD_LINK');
		if ([...args.password].length < MIN_PASSWORD_LENGTH) fail('PASSWORD_TOO_SHORT');
		if (new TextEncoder().encode(args.password).length > 72) fail('PASSWORD_TOO_LONG');
		const user = (await ctx.db.get(link.user_id)) ?? fail('INVALID_PASSWORD_LINK');
		const account = await ctx.db.query('authAccounts').withIndex('userIdAndProvider', (q) => q.eq('userId', user._id).eq('provider', 'password')).unique();
		const secret = hashPassword(args.password);
		if (account) await ctx.db.patch(account._id, { secret });
		else await ctx.db.insert('authAccounts', { userId: user._id, provider: 'password', providerAccountId: user.email!, secret });
		await ctx.db.patch(link._id, { used_at: Date.now() });
		if (user.emailVerificationTime === undefined) await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
		return { email: user.email! };
	}
});
