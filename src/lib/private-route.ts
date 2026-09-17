import { stripLocale } from './i18n';

/** Resolved routes remain private when their URL uses percent-encoded letters. */
export function isPrivateRoute(routeId: string | null, pathname: string): boolean {
	if (routeId && /(?:^|\/)(?:checkout|admin|api\/checkouts)(?:\/|$)/.test(routeId)) return true;
	// Unmatched private URLs need the same headers. Decode like route matching,
	// retaining escaped separators and safely handling malformed escapes.
	let path = pathname;
	try { path = decodeURI(pathname); } catch { /* Fall back to the original path. */ }
	return /^\/(?:checkout|admin|api\/checkouts)(?:\/|$)/.test(stripLocale(path));
}
