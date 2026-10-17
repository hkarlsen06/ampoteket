import { PUBLIC_CONVEX_URL } from '$app/env/public';
import { ConvexHttpClient } from 'convex/browser';
import type { ConvexConfig } from '#lib/convex.js';

/** The public deployment URL, or null when unconfigured (features report themselves unavailable). */
export function getConvexConfig(): ConvexConfig | null {
	if (typeof PUBLIC_CONVEX_URL !== 'string' || !PUBLIC_CONVEX_URL) return null;
	try {
		const url = new URL(PUBLIC_CONVEX_URL);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
		return { url: url.href.replace(/\/$/, '') };
	} catch { return null; }
}

/** An unauthenticated client for one server request (SSR reads, the checkout gateway). */
export function serverConvex(config = getConvexConfig()): ConvexHttpClient | null {
	return config ? new ConvexHttpClient(config.url, { logger: false }) : null;
}
