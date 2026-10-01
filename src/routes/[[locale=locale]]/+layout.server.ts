import { env } from '$env/dynamic/private';
import { getCatalogConfig } from '$lib/server/catalog-config';
import { salesOpen } from '$lib/server/sales';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ platform, request }) => {
	const bindings = platform?.env as unknown as Record<string, unknown> | undefined;
	const configured = bindings?.CHECKOUT_ALLOWED_ORIGIN ?? env.CHECKOUT_ALLOWED_ORIGIN;
	let callbackOrigin: string | null = null;
	try {
		const url = new URL(String(configured));
		if (url.protocol === 'https:' && url.origin === configured && !url.username && !url.password) callbackOrigin = url.origin;
	} catch { /* Missing configuration disables email redirects. */ }
	return { adminConfig: getCatalogConfig(platform, request), callbackOrigin, salesOpen: salesOpen(platform) };
};
