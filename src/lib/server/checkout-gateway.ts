import { ApiError, requestApiJson } from '../api';
import { readJsonBody, RequestBodyError } from './request-body';
import { checkoutUuid, parseCheckoutBinding, parseCheckoutSnapshot, parsePrepareRequest, parsePrepareResponse } from '../checkout-contract';
import { receiptAddress, sendReceipt, type ReceiptConfig } from './receipt-email';
import { checkoutSessionFingerprint, checkoutTokenForAttempt, newCheckoutSessionSecret } from './checkout-credentials';

export type CheckoutOperation = 'session' | 'prepare' | 'get' | 'confirm' | 'receipt';
export type CheckoutRateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type CheckoutGatewayConfig = {
	origin: string;
	apiUrl: string;
	secretKey: string;
	sessionLimit: CheckoutRateLimit;
	operationLimit: CheckoutRateLimit;
	/** Absent: receipt requests fail with RECEIPT_UNAVAILABLE. */
	receipt?: ReceiptConfig;
};
export const CHECKOUT_COOKIE = '__Host-amp_checkout';
export const CHECKOUT_COOKIE_OPTIONS = {
	path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const, maxAge: 31536000
};
type CookieJar = { get(name: string): string | undefined; set(name: string, value: string, options: typeof CHECKOUT_COOKIE_OPTIONS): void };
type GatewayContext = {
	request: Request;
	cookies: CookieJar;
	clientAddress: string;
	checkoutId?: string;
	fetcher?: typeof fetch;
};
class GatewayError extends Error {
	constructor(readonly code: string, readonly status: number) { super(code); }
}
function fail(code: string, status = 400): never { throw new GatewayError(code, status); }
const credentialErrors = new Set(['CHECKOUT_SESSION_MISSING', 'CHECKOUT_SESSION_CHANGED', 'INVALID_CHECKOUT_SESSION', 'INVALID_CHECKOUT_ATTEMPT']);
const databaseErrors = new Set(['IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT', 'INVALID_QUANTITY_STEP',
	'POSITIVE_CART_QUANTITY_REQUIRED', 'DUPLICATE_OR_MISSING_CART_PRODUCT', 'PRODUCT_NOT_FOUND',
	'PRODUCT_NOT_FOR_SALE', 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED']);

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: {
		'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
		'CDN-Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {})
	} });
}

function validateConfig(config: CheckoutGatewayConfig | null): asserts config is CheckoutGatewayConfig {
	if (!config) fail('CHECKOUT_UNAVAILABLE', 503);
	try {
		const origin = new URL(config.origin);
		const api = new URL(config.apiUrl);
		if (origin.protocol !== 'https:' || origin.origin !== config.origin
			|| api.origin !== config.apiUrl || (api.protocol !== 'https:'
				&& !(api.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)))
			|| typeof config.secretKey !== 'string' || !config.secretKey
			|| !config.sessionLimit?.limit || !config.operationLimit?.limit) fail('CHECKOUT_UNAVAILABLE', 503);
		if (!config.secretKey.startsWith('sb_secret_')) {
			const payload = JSON.parse(atob(config.secretKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			if (payload.role !== 'service_role') fail('CHECKOUT_UNAVAILABLE', 503);
		}
	} catch { fail('CHECKOUT_UNAVAILABLE', 503); }
}

/** Never logs request/response bodies, cookies, credentials or database diagnostics. */
export async function checkoutGateway(operation: CheckoutOperation, context: GatewayContext,
	config: CheckoutGatewayConfig | null): Promise<Response> {
	try {
		validateConfig(config);
		const { request, cookies } = context;
		if (request.method !== 'POST') fail('CHECKOUT_POST_REQUIRED', 405);
		if (request.headers.get('Origin') !== config.origin
			|| (request.headers.has('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) {
			fail('CHECKOUT_ORIGIN_REJECTED', 403);
		}
		if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
			fail('CHECKOUT_JSON_REQUIRED', 415);
		}
		const limiter = operation === 'session' ? config.sessionLimit : config.operationLimit;
		if (!(await limiter.limit({ key: `ip:${context.clientAddress}` })).success) fail('CHECKOUT_RATE_LIMITED', 429);
		const body = await readJsonBody(request, operation === 'prepare' ? 32768 : 1024);
		if (operation === 'session') {
			if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) fail('INVALID_CHECKOUT_REQUEST');
			// A present malformed cookie is a visible credential error, never silently replaced.
			const root = cookies.get(CHECKOUT_COOKIE) ?? newCheckoutSessionSecret();
			const fingerprint = await checkoutSessionFingerprint(root);
			cookies.set(CHECKOUT_COOKIE, root, CHECKOUT_COOKIE_OPTIONS);
			return response({ fingerprint });
		}
		let binding;
		let prepared;
		let receiptTo: string | null = null;
		try {
			if (operation === 'prepare') { prepared = parsePrepareRequest(body); binding = prepared; }
			else if (operation === 'receipt') {
				const { email, ...rest } = body as Record<string, unknown>;
				binding = parseCheckoutBinding(rest);
				receiptTo = receiptAddress(email);
			} else binding = parseCheckoutBinding(body);
		} catch { return fail('INVALID_CHECKOUT_REQUEST'); }
		if (operation === 'receipt' && !receiptTo) fail('INVALID_RECEIPT_EMAIL');
		if (operation === 'receipt' && !config.receipt) fail('RECEIPT_UNAVAILABLE', 503);
		if (operation !== 'prepare' && (!context.checkoutId || !checkoutUuid.test(context.checkoutId))) fail('INVALID_CHECKOUT_REQUEST');
		const root = cookies.get(CHECKOUT_COOKIE);
		const token = await checkoutTokenForAttempt(root, binding.request_id, binding.fingerprint);
		if (!(await config.operationLimit.limit({ key: `session:${binding.fingerprint}` })).success) fail('CHECKOUT_RATE_LIMITED', 429);
		cookies.set(CHECKOUT_COOKIE, root!, CHECKOUT_COOKIE_OPTIONS);
		const rpc = operation === 'prepare' ? 'amp_prepare_checkout' : operation === 'confirm' ? 'amp_confirm_checkout' : 'amp_get_checkout';
		const payload = prepared
			? { p_request_id: prepared.request_id, p_token: token, p_items: prepared.items, p_contact_text: prepared.contact }
			: { p_checkout_id: context.checkoutId, p_token: token };
		const result = await requestApiJson(`${config.apiUrl}/rest/v1/rpc/${rpc}`, {
			method: 'POST', headers: { apikey: config.secretKey,
				...(config.secretKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${config.secretKey}` }),
				'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(payload), credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
		}, context.fetcher);
		if (operation === 'prepare') return response(parsePrepareResponse(result));
		const snapshot = parseCheckoutSnapshot(result);
		if (snapshot.checkout_id !== context.checkoutId || (operation === 'confirm' && snapshot.status !== 'confirmed')) {
			fail('CHECKOUT_UNAVAILABLE', 503);
		}
		if (operation === 'receipt') {
			if (snapshot.status !== 'confirmed') fail('CHECKOUT_NOT_REGISTERED', 409);
			// Spam guard: a few addresses per checkout; the operation limits apply too.
			if (!(await config.receipt!.limit.limit({ key: `receipt:${snapshot.checkout_id}` })).success) fail('CHECKOUT_RATE_LIMITED', 429);
			if (!await sendReceipt(snapshot, receiptTo!, { ...config.receipt!, origin: config.origin }, context.fetcher)) fail('RECEIPT_UNAVAILABLE', 503);
			return response({ sent: true });
		}
		return response(snapshot);
	} catch (error) {
		if (error instanceof RequestBodyError) return response({ error: error.code === 'INVALID_REQUEST' ? 'INVALID_CHECKOUT_REQUEST' : `CHECKOUT_${error.code}` }, error.status);
		if (error instanceof GatewayError) return response({ error: error.code }, error.status);
		if (error instanceof Error && credentialErrors.has(error.message)) return response({ error: error.message }, 409);
		if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'message' in error.body) {
			const raw = error.body.message;
			const code = typeof raw === 'string' ? raw.split(':')[0] : '';
			if (databaseErrors.has(code)) return response({ error: code }, code === 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED' ? 403 : 409);
		}
		return response({ error: 'CHECKOUT_UNAVAILABLE' }, 503);
	}
}
