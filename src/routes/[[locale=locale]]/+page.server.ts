import { getCatalogConfig } from '$lib/server/catalog-config';
import { readShelfTopology } from '$lib/shelf-map';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, request, fetch, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const catalogConfig = getCatalogConfig(platform, request);
	// Render the real wall geometry on first paint; a failed optional map read
	// never prevents the presentation page from loading.
	const shelfTopology = catalogConfig
		? await readShelfTopology(catalogConfig, { fetcher: fetch, signal: AbortSignal.timeout(3000) }).catch(() => null)
		: null;
	return { catalogConfig, shelfTopology };
};
