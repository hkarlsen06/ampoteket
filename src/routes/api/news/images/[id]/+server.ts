// A newsroom image from the database (amp_news_image), which returns it only while a
// published article or event shows it. Stored images never change, but unpublishing
// must take one down, so caches keep it for an hour rather than for ever.
import { error } from '@sveltejs/kit';
import { requestApiJson, object, uuidPattern } from '#lib/api.js';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { RequestHandler } from './$types';

const types = new Set(['image/webp', 'image/jpeg', 'image/png']);

export const GET: RequestHandler = async ({ params, request, fetch }) => {
	if (!uuidPattern.test(params.id)) error(404);
	const config = getCatalogConfig(request);
	if (!config) error(503);
	const rows = await requestApiJson(new URL('/rest/v1/rpc/amp_news_image', config.url), {
		method: 'POST', cache: 'no-store', credentials: 'omit',
		headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({ p_id: params.id })
	}, fetch).catch(() => null);
	if (!Array.isArray(rows)) error(502);
	if (!rows.length) error(404);
	const row = object(rows[0]);
	if (typeof row.content_type !== 'string' || !types.has(row.content_type) || typeof row.data !== 'string') error(502);
	let bytes: Uint8Array<ArrayBuffer>;
	try { bytes = Uint8Array.from(atob(row.data), char => char.charCodeAt(0)); } catch { error(502); }
	return new Response(bytes, { headers: {
		'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=3600',
		'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
	} });
};
