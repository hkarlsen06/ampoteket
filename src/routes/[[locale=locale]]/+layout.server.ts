import { CHECKOUT_ALLOWED_ORIGIN } from '$app/env/private';
import { getCatalogConfig } from '#lib/server/catalog-config.js';
import { salesOpen } from '#lib/server/sales.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ request }) => {
	const configured = CHECKOUT_ALLOWED_ORIGIN;
	let callbackOrigin: string | null = null;
	try {
		const url = new URL(String(configured));
		if (url.protocol === 'https:' && url.origin === configured && !url.username && !url.password) callbackOrigin = url.origin;
	} catch { /* Missing configuration disables email redirects. */ }
	return { adminConfig: getCatalogConfig(request), callbackOrigin, salesOpen: salesOpen() };
};
