import { error } from '@sveltejs/kit';
import { readNewsArticle, slugPattern } from '#lib/news.js';
import { serverConvex } from '#lib/server/convex.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	if (!slugPattern.test(params.slug) || params.slug.length > 80) error(404);
	const client = serverConvex();
	if (!client) return { article: null };
	let article;
	try { article = await readNewsArticle(client, params.slug); }
	catch { return { article: null }; }
	if (!article) error(404);
	return { article };
};
