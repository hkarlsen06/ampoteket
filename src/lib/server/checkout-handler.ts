import { CHECKOUT_ALLOWED_ORIGIN as origin, SUPABASE_SECRET_KEY as secretKey, RESEND_API_KEY as resendApiKey } from '$app/env/private';
import { env, waitUntil } from 'cloudflare:workers';
import { getCatalogConfig } from './catalog-config';
import { checkoutGateway, type CheckoutGatewayConfig, type CheckoutOperation } from './checkout-gateway';
import type { ReceiptConfig } from './receipt-email';
import { salesOpen } from './sales';
import type { RequestEvent } from '@sveltejs/kit';

export function handleCheckout(operation: CheckoutOperation, event: RequestEvent): Promise<Response> {
	const publicConfig = getCatalogConfig();
	// Closed sales answer like a missing configuration: 503 CHECKOUT_UNAVAILABLE.
	const config = salesOpen() && publicConfig && typeof origin === 'string' && typeof secretKey === 'string' ? {
		origin, apiUrl: publicConfig.url, secretKey,
		sessionLimit: env.CHECKOUT_SESSION_LIMIT,
		operationLimit: env.CHECKOUT_OPERATION_LIMIT,
		receipt: typeof resendApiKey === 'string' && resendApiKey && env.RECEIPT_LIMIT
			? { resendApiKey, limit: env.RECEIPT_LIMIT } as ReceiptConfig : undefined
	} as CheckoutGatewayConfig : null;
	let clientAddress = 'unavailable';
	try { clientAddress = event.getClientAddress(); } catch { /* A missing address shares a conservative limit. */ }
	return checkoutGateway(operation, {
		request: event.request, cookies: event.cookies, clientAddress,
		checkoutId: event.params.id, fetcher: event.fetch,
		waitUntil
	}, config);
}
