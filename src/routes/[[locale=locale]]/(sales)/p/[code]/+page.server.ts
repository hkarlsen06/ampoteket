import { error, isRedirect, redirect } from '@sveltejs/kit';
import { lookupCatalogProduct } from '#lib/catalog.js';
import { readShelfTopology } from '#lib/shelf-map.js';
import { serverConvex } from '#lib/server/convex.js';
import { defaultLocale, isLocale, localizeHref } from '#lib/i18n/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	const code = params.code.toUpperCase();
	if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code)) error(404);
	const locale = isLocale(params.locale) ? params.locale : defaultLocale;
	if (params.code !== code) redirect(308, localizeHref(`/p/${code}`, locale));
	const client = serverConvex();
	if (!client) return { code, product: null, unavailable: true, shelfTopology: null };
	try {
		const [product, shelfTopology] = await Promise.all([
			lookupCatalogProduct(client, code, { allowCompactCode: true }),
			readShelfTopology(client, { signal: AbortSignal.timeout(3000) }).catch(() => null)
		]);
		if (product && product.code !== code) redirect(303, localizeHref(`/p/${product.code}`, locale));
		if (product) return { code, product, unavailable: false, shelfTopology };
	} catch (cause) {
		if (isRedirect(cause)) throw cause;
		return { code, product: null, unavailable: true, shelfTopology: null };
	}
	error(404);
};
