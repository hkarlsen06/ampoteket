import { readHelpDirectory } from '#lib/help.js';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ request, fetch, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const config = getCatalogConfig(request);
	if (!config) return { contacts: null };
	try { return { contacts: await readHelpDirectory(config, fetch) }; }
	catch { return { contacts: null }; }
};
