import { errorCode } from './convex';

/** A return path never carries credentials, another origin or an unbuilt screen. */
export function adminReturnPath(value: string | null): string {
	return value && /^\/admin(?:\/(?:purchases|contacts|admins|shelf|stock|statistics|audit|products(?:\/(?:new|labels|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?|(?:counts|orders)(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?))?$/.test(value) ? value : '/admin';
}

/**
 * Tell a refused sign-in from an unreachable service. A wrong password, an
 * unknown email and too many failed attempts all answer INVALID_CREDENTIALS
 * (convex/session.ts), so `invalid` reveals nothing about which accounts exist.
 * Anything else, including a network failure, is not the person's mistake.
 */
export type SignInFailure = 'invalid' | 'unavailable';
export function signInFailure(error: unknown): SignInFailure {
	return errorCode(error) === 'INVALID_CREDENTIALS' ? 'invalid' : 'unavailable';
}

/** A link from an invitation or reset email: `?token_hash=<64 hex>&type=invite|recovery`. */
export function passwordLinkToken(url: URL): { token: string; type: 'invite' | 'recovery' } | 'invalid' | null {
	const token = url.searchParams.get('token_hash'), type = url.searchParams.get('type');
	if (url.hash || url.searchParams.has('error') || url.searchParams.has('code') || url.searchParams.getAll('token_hash').length > 1
		|| url.searchParams.getAll('type').length > 1) return 'invalid';
	if (token === null && type === null) return null;
	return token && /^[a-f0-9]{64}$/.test(token) && (type === 'invite' || type === 'recovery') ? { token, type } : 'invalid';
}
