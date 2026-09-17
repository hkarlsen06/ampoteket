import { redirect } from '@sveltejs/kit';
import { lookupCatalogProduct, readCatalogPage, type CatalogPage } from '$lib/catalog';
import { CatalogQueryError, hasCatalogFilters, normalizeProductCode, parseCatalogQuery, sanitizeCatalogQuery, type CatalogQuery } from '$lib/catalog-search';
import { localeFromPathname, localizeHref } from '$lib/i18n';
import { getCatalogConfig } from '$lib/server/catalog-config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, platform, request, fetch, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	// Legacy direct-lookup links: ?code= still redirects on a valid code.
	let codeError = false;
	const code = url.searchParams.get('code') ?? '';
	if (url.searchParams.has('code')) {
		let normalized: string | undefined;
		try {
			if (url.searchParams.getAll('code').length !== 1) throw new Error();
			normalized = normalizeProductCode(code);
		} catch { codeError = true; }
		if (normalized) redirect(303, localizeHref(`/p/${normalized}`, localeFromPathname(url.pathname)));
	}
	const queryString = sanitizeCatalogQuery(url.searchParams).toString();
	let queryError: CatalogQueryError['issue'] | null = null;
	let parsed: CatalogQuery | null = null;
	try { parsed = parseCatalogQuery(new URLSearchParams(queryString)); }
	catch (error) { queryError = error instanceof CatalogQueryError ? error.issue : 'invalidQuery'; }
	const config = getCatalogConfig(platform, request);
	// Unified search: a query that is exactly one existing part code opens that
	// part directly — the label fast path, working without JavaScript and before
	// other catalog data has loaded. A code-shaped query for a part that does
	// not exist falls through to ordinary text search (codes are searchable text
	// too), and a probe failure never blocks the search flow.
	if (config && parsed?.q && !parsed.after && !hasCatalogFilters({ ...parsed, q: '' })) {
		let normalized: string | undefined;
		try { normalized = normalizeProductCode(parsed.q); } catch { /* plain text search */ }
		if (normalized) {
			let foundCode: string | undefined;
			try { foundCode = (await lookupCatalogProduct(config, normalized, { fetcher: fetch, allowCompactCode: true }))?.code; }
			catch { /* catalog unavailable; the search flow reports it */ }
			if (foundCode) redirect(303, localizeHref(`/p/${foundCode}`, localeFromPathname(url.pathname)));
		}
	}
	let initialPage: CatalogPage | null = null;
	let unavailable = !config;
	if (config && !queryError) {
		try { initialPage = await readCatalogPage(config, { fetcher: fetch, limit: 50, query: parsed! }); }
		catch (error) {
			if (error instanceof CatalogQueryError) queryError = error.issue;
			else unavailable = true;
		}
	}
	return { config, initialPage, unavailable, queryString, queryError, code, codeError };
};
