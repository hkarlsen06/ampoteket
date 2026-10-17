/**
 * Password sign-in for the admin pages. Wraps Convex Auth's `auth:signIn` so a
 * refused sign-in arrives as the domain code INVALID_CREDENTIALS (production
 * hides plain error messages), distinct from an unavailable service. A wrong
 * password, an unknown address and too many failed attempts answer alike,
 * revealing nothing about which accounts exist.
 */
import { v } from 'convex/values';
import { action } from './_generated/server';
import { api } from './_generated/api';
import { fail } from './lib/errors';

export const signIn = action({
	args: { email: v.string(), password: v.string() },
	handler: async (ctx, { email, password }): Promise<{ token: string; refreshToken: string }> => {
		let result;
		try {
			result = await ctx.runAction(api.auth.signIn, { provider: 'password', params: { email, password, flow: 'signIn' } });
		} catch (error) {
			// Wrong password, unknown address and the failed-attempt limit all read the same.
			if (error instanceof Error && /InvalidSecret|InvalidAccountId|TooManyFailedAttempts|Invalid credentials/.test(error.message)) fail('INVALID_CREDENTIALS');
			throw error;
		}
		if (!result.tokens) fail('INVALID_CREDENTIALS');
		return result.tokens;
	}
});
