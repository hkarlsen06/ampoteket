import { getCatalogConfig } from '$lib/server/catalog-config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ platform, request, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	return { catalogConfig: getCatalogConfig(platform, request) };
};
