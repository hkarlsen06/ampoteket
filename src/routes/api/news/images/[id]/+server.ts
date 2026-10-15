// A newsroom image (news.image), which the backend returns only while a published
// article or event shows it. Stored images never change, but unpublishing must take
// one down, so caches keep it for an hour rather than for ever.
import { error } from '@sveltejs/kit';
import { uuidPattern } from '#lib/api.js';
import { api } from '#lib/convex.js';
import { serverConvex } from '#lib/server/convex.js';
import type { RequestHandler } from './$types';

const types = new Set(['image/webp', 'image/jpeg', 'image/png']);

export const GET: RequestHandler = async ({ params }) => {
	if (!uuidPattern.test(params.id)) error(404);
	const client = serverConvex();
	if (!client) error(503);
	let row;
	try { row = await client.query(api.news.image, { id: params.id }); } catch { error(502); }
	if (!row) error(404);
	if (!types.has(row.content_type) || !(row.data instanceof ArrayBuffer)) error(502);
	return new Response(row.data, { headers: {
		'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=3600',
		'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
	} });
};
