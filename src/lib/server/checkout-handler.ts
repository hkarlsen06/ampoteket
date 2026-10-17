import { CHECKOUT_ALLOWED_ORIGIN as origin, CHECKOUT_SERVER_KEY as serverKey, RESEND_API_KEY as resendApiKey } from '$app/env/private';
import { env, waitUntil } from 'cloudflare:workers';
import { getConvexConfig } from './convex';
import { checkoutGateway, type CheckoutGatewayConfig, type CheckoutOperation } from './checkout-gateway';
import type { ReceiptConfig } from './receipt-email';
import { salesOpen } from './sales';
import type { RequestEvent } from '@sveltejs/kit';

export function handleCheckout(operation: CheckoutOperation, event: RequestEvent): Promise<Response> {
	const convex = getConvexConfig();
	// Closed sales answer like a missing configuration: 503 CHECKOUT_UNAVAILABLE.
	const config = salesOpen() && convex && typeof origin === 'string' && typeof serverKey === 'string' ? {
		origin, convexUrl: convex.url, serverKey,
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
