import { error } from '@sveltejs/kit';
import { readEvent, slugPattern } from '#lib/news.js';
import { serverConvex } from '#lib/server/convex.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	if (!slugPattern.test(params.slug) || params.slug.length > 80) error(404);
	const client = serverConvex();
	if (!client) return { event: null };
	let event;
	try { event = await readEvent(client, params.slug); }
	catch { return { event: null }; }
	if (!event) error(404);
	return { event };
};
