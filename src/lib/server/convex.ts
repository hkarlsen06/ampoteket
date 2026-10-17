import { PUBLIC_CONVEX_URL } from '$app/env/public';
import { CONVEX_DEV_PROXY } from '$app/env/private';
import { ConvexHttpClient } from 'convex/browser';
import type { ConvexConfig } from '#lib/convex.js';

function parse(value: unknown): ConvexConfig | null {
	if (typeof value !== 'string' || !value) return null;
	try {
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
		return { url: url.href.replace(/\/$/, '') };
	} catch { return null; }
}

/** The deployment URL for server code, or null when unconfigured (features report themselves unavailable). */
export function getConvexConfig(): ConvexConfig | null {
	return parse(CONVEX_DEV_PROXY) ?? parse(PUBLIC_CONVEX_URL);
}

/**
 * The deployment URL the browser uses. In development the local backend sits
 * behind the dev server at /_convex on the page's own origin (vite.config.ts).
 */
export function browserConvexConfig(request: Request): ConvexConfig | null {
	if (!parse(CONVEX_DEV_PROXY)) return parse(PUBLIC_CONVEX_URL);
	const url = new URL(request.url);
	// A local HTTPS proxy (Caddy) forwards plain HTTP to Vite.
	if (request.headers.get('x-forwarded-proto') === 'https') url.protocol = 'https:';
	return { url: `${url.origin}/_convex` };
}

/** An unauthenticated client for one server request (SSR reads, the checkout gateway). */
export function serverConvex(config = getConvexConfig()): ConvexHttpClient | null {
	return config ? new ConvexHttpClient(config.url, { logger: false }) : null;
}
