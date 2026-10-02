// A widget avatar from Discord's CDN, so visitors' browsers never contact Discord.
// Only widget-avatar paths are accepted: this must not become an open proxy.
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!/^[\w-]+\/[\w-]+$/.test(params.path)) error(404);
	const response = await fetch(`https://cdn.discordapp.com/widget-avatars/${params.path}?size=64`, {
		signal: AbortSignal.timeout(5000), cf: { cacheTtl: 86400, cacheEverything: true }
	}).catch(() => null);
	if (!response?.ok || !response.headers.get('Content-Type')?.startsWith('image/')) error(502);
	const body = await response.arrayBuffer().catch(() => null);
	if (!body) error(502);
	// The path changes whenever the avatar does.
	return new Response(body, { headers: { 'Content-Type': response.headers.get('Content-Type')!, 'Cache-Control': 'public, max-age=86400, immutable' } });
};
