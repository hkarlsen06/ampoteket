import { readHelpDirectory } from '$lib/help';
import { getCatalogConfig } from '$lib/server/catalog-config';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ platform, request, fetch, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const config = getCatalogConfig(platform, request);
	if (!config) return { contacts: null };
	try { return { contacts: await readHelpDirectory(config, fetch) }; }
	catch { return { contacts: null }; }
};
