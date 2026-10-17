/**
 * Convex Auth: email and password sign-in for staff only.
 *
 * Passwords are bcrypt hashes, the format Supabase Auth used, so the imported
 * hashes keep every admin's existing password. Sign-up is off: accounts are
 * created only by an invitation from active staff (convex/members.ts), and
 * passwords are set through single-use links (convex/passwords.ts).
 */
import { convexAuth } from '@convex-dev/auth/server';
import { Password } from '@convex-dev/auth/providers/Password';
import { ConvexError } from 'convex/values';
import bcrypt from 'bcryptjs';

/** Cost 10, as Supabase used. Synchronous: Convex Auth verifies inside a mutation, where timers are unavailable. */
export const hashPassword = (password: string) => bcrypt.hashSync(password, 10);
export const MIN_PASSWORD_LENGTH = 8;

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [Password({
		profile(params) {
			if (params.flow !== 'signIn') throw new ConvexError({ code: 'SIGN_IN_ONLY', message: 'SIGN_IN_ONLY' });
			return { email: String(params.email ?? '').trim().toLowerCase() };
		},
		crypto: {
			hashSecret: async (password) => hashPassword(password),
			verifySecret: async (password, hash) => bcrypt.compareSync(password, hash)
		}
	})]
});
