import { error } from '@sveltejs/kit';
import { readNewsArticle, slugPattern } from '#lib/news.js';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, fetch, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	if (!slugPattern.test(params.slug) || params.slug.length > 80) error(404);
	const config = getCatalogConfig(request);
	if (!config) return { article: null };
	let article;
	try { article = await readNewsArticle(config, params.slug, fetch); }
	catch { return { article: null }; }
	if (!article) error(404);
	return { article };
};
