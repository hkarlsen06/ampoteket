import { readHelpDirectory } from '#lib/help.js';
import { serverConvex } from '#lib/server/convex.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const client = serverConvex();
	if (!client) return { contacts: null };
	try { return { contacts: await readHelpDirectory(client) }; }
	catch { return { contacts: null }; }
};
