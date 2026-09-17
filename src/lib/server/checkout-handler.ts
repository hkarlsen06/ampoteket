import { env } from '$env/dynamic/private';
import { getCatalogConfig } from './catalog-config';
import { checkoutGateway, type CheckoutGatewayConfig, type CheckoutOperation } from './checkout-gateway';
import type { RequestEvent } from '@sveltejs/kit';

export function handleCheckout(operation: CheckoutOperation, event: RequestEvent): Promise<Response> {
	const bindings = event.platform?.env as unknown as Record<string, unknown> | undefined;
	const publicConfig = getCatalogConfig(event.platform);
	const origin = bindings?.CHECKOUT_ALLOWED_ORIGIN ?? env.CHECKOUT_ALLOWED_ORIGIN;
	const secretKey = bindings?.SUPABASE_SECRET_KEY ?? env.SUPABASE_SECRET_KEY;
	const config = publicConfig && typeof origin === 'string' && typeof secretKey === 'string' ? {
		origin, apiUrl: publicConfig.url, secretKey,
		sessionLimit: bindings?.CHECKOUT_SESSION_LIMIT,
		operationLimit: bindings?.CHECKOUT_OPERATION_LIMIT
	} as CheckoutGatewayConfig : null;
	let clientAddress = 'unavailable';
	try { clientAddress = event.getClientAddress(); } catch { /* A missing address shares a conservative limit. */ }
	return checkoutGateway(operation, {
		request: event.request, cookies: event.cookies, clientAddress,
		checkoutId: event.params.id, fetcher: event.fetch
	}, config);
}
