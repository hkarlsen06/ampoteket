import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ request, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	return { catalogConfig: getCatalogConfig(request) };
};
