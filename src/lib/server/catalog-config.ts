import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import type { CatalogConfig } from '$lib/catalog';

/** Development only: the page's own origin, when the dev server proxies the API. */
function proxiedApiOrigin(request?: Request): string | undefined {
	if (!request || !privateEnv.SUPABASE_API_PROXY) return undefined;
	const url = new URL(request.url);
	// A local HTTPS proxy (Caddy) forwards plain HTTP to Vite.
	if (request.headers.get('x-forwarded-proto') === 'https') url.protocol = 'https:';
	return url.origin;
}

/** Only public configuration crosses the SSR boundary; missing config is unavailable. */
export function getCatalogConfig(platform?: App.Platform, request?: Request): CatalogConfig | null {
	const bindings = platform?.env as unknown as Record<string, unknown> | undefined;
	const url = proxiedApiOrigin(request) ?? bindings?.PUBLIC_SUPABASE_URL ?? env.PUBLIC_SUPABASE_URL;
	const publishableKey = bindings?.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
	if (typeof url !== 'string' || typeof publishableKey !== 'string' || !publishableKey.trim()) return null;
	// Catch accidental secret-key configuration before returning anything to a page.
	if (!publishableKey.startsWith('sb_publishable_')) {
		try {
			const payload = JSON.parse(atob(publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			if (payload.role !== 'anon') return null;
		} catch { return null; }
	}
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
			|| parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
		return { url: parsed.origin, publishableKey };
	} catch { return null; }
}
