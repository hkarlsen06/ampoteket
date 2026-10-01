// The locale is decided by the URL prefix (see src/lib/i18n). `<html lang>` sits
// outside the Svelte app, so it is patched into the shell here, per request.
import type { Handle, HandleFetch } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { htmlLang, localeFromPathname } from '$lib/i18n';
import { isPrivateRoute } from '$lib/private-route';

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.hostname === 'www.ampoteket.no') {
		return new Response(null, { status: 308, headers: { Location: `https://ampoteket.no${event.url.pathname}${event.url.search}` } });
	}
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%lang%', htmlLang[localeFromPathname(event.url.pathname)])
	});
	if (isPrivateRoute(event.route.id, event.url.pathname)) {
		// Covers HTML, navigation data, API errors and unsupported methods alike.
		const headers = new Headers(response.headers);
		headers.set('Cache-Control', 'no-store');
		headers.set('CDN-Cache-Control', 'no-store');
		headers.set('Referrer-Policy', 'no-referrer');
		headers.set('X-Robots-Tag', 'noindex, nofollow');
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
	return response;
};

// Development only (`bun run development`): SvelteKit answers same-origin fetches
// itself, so send server-side calls to the proxied API paths straight to the API.
export const handleFetch: HandleFetch = ({ event, request, fetch }) => {
	const target = env.SUPABASE_API_PROXY;
	const url = new URL(request.url);
	if (target && url.host === event.url.host && /^\/(auth|rest)\/v1\//.test(url.pathname)) {
		return fetch(new Request(new URL(url.pathname + url.search, target), request));
	}
	return fetch(request);
};
