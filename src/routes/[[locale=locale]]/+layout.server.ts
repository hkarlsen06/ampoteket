import { CHECKOUT_ALLOWED_ORIGIN } from '$app/env/private';
import { getConvexConfig } from '#lib/server/convex.js';
import { salesOpen } from '#lib/server/sales.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const configured = CHECKOUT_ALLOWED_ORIGIN;
	let callbackOrigin: string | null = null;
	try {
		const url = new URL(String(configured));
		if (url.protocol === 'https:' && url.origin === configured && !url.username && !url.password) callbackOrigin = url.origin;
	} catch { /* Missing configuration disables email redirects. */ }
	return { convex: getConvexConfig(), callbackOrigin, salesOpen: salesOpen() };
};
