import { describe, expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { rejection, type ConvexCaller } from '../convex';
import { checkoutGateway, CHECKOUT_COOKIE, type CheckoutGatewayConfig } from './checkout-gateway';
import { checkoutSessionFingerprint, checkoutTokenForAttempt } from './checkout-credentials';
import { parseCheckoutSnapshot, parsePrepareRequest, type CheckoutSnapshot } from '../checkout-contract';

const root = '31'.repeat(32);
const request_id = '12345678-1234-4123-8123-123456789abc';
const checkout_id = '87654321-1234-4123-8123-123456789abc';
const product_id = '11111111-1234-4123-8123-123456789abc';
const origin = 'https://shop.example.test';
const snapshot: CheckoutSnapshot = {
	checkout_id, created_at: '2026-09-20T12:00:00+00:00', status: 'unconfirmed', confirmed_at: null,
	total_nok: '999999999998.99', payment_required: true, registration_method: null, contact_text: null,
	items: [{ product_id, code: 'RES-A1234', name_nb: 'Motstand', name_en: 'Resistor', unit: 'pcs',
		quantity: '1', unit_price_nok: '999999999998.999999', line_total_nok: '999999999998.99' }]
};
const serverKey = 'k'.repeat(32);
function harness() {
	const jar = new Map<string, string>();
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const fetches: { url: string; init?: RequestInit }[] = [];
	const cookieWrites: unknown[] = [];
	const background: Promise<unknown>[] = [];
	let answer: () => unknown = () => snapshot;
	const call = async (fn: FunctionReference<'query' | 'mutation'>, args: Record<string, unknown>) => {
		calls.push({ name: getFunctionName(fn), args });
		return structuredClone(answer());
	};
	const client = { query: call, mutation: call, action: async () => { throw new Error('Unexpected action'); } } as unknown as ConvexCaller;
	const config: CheckoutGatewayConfig = {
		origin, convexUrl: 'https://deployment.example.test', serverKey, client,
		sessionLimit: { limit: async () => ({ success: true }) },
		operationLimit: { limit: async () => ({ success: true }) }
	};
	const cookies = {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string, options: unknown) => { jar.set(name, value); cookieWrites.push(options); }
	};
	const post = async (operation: 'session' | 'prepare' | 'get' | 'confirm' | 'receipt', body: unknown,
		init: RequestInit = {}, id = checkout_id) => {
		const response = await checkoutGateway(operation, {
			request: new Request(`${origin}/api/checkouts/test`, {
				method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify(body), ...init
			}), cookies, clientAddress: '127.0.0.1', checkoutId: id,
			fetcher: (async (url, init) => {
				fetches.push({ url: String(url), init });
				return new Response('{}');
			}) as typeof fetch,
			waitUntil: (promise) => background.push(promise)
		}, config);
		return { response, body: await response.json() as Record<string, unknown> };
	};
	return { jar, calls, fetches, cookieWrites, background, config, post,
		respond: (body: unknown) => { answer = () => body; },
		reject: (error: unknown) => { answer = () => { throw error; }; } };
}
const binding = { request_id, fingerprint: await checkoutSessionFingerprint(root) };
const prepare = { ...binding, items: [{ product_id, quantity: '0.000001' }], contact: 'Optional contact' };

describe('checkout gateway trust boundary', () => {
	test('explicit initialization creates a secure root and reuses it without returning it', async () => {
		const h = harness();
		const first = await h.post('session', {});
		expect(first.response.status).toBe(200);
		expect(first.response.headers.get('cache-control')).toBe('no-store');
		expect(first.response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(h.cookieWrites[0]).toEqual({ path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 31536000 });
		expect(JSON.stringify(first.body)).not.toContain(h.jar.get(CHECKOUT_COOKIE)!);
		expect((await h.post('session', {})).body).toEqual(first.body);
		expect(h.calls).toHaveLength(0);
	});
	test('missing, malformed and replaced roots never recreate credentials during an attempt', async () => {
		const h = harness();
		expect((await h.post('get', binding)).body.error).toBe('CHECKOUT_SESSION_MISSING');
		h.jar.set(CHECKOUT_COOKIE, 'broken');
		expect((await h.post('session', {})).body.error).toBe('INVALID_CHECKOUT_SESSION');
		h.jar.set(CHECKOUT_COOKIE, '32'.repeat(32));
		expect((await h.post('prepare', prepare)).body.error).toBe('CHECKOUT_SESSION_CHANGED');
		expect(h.cookieWrites).toHaveLength(0);
		expect(h.calls).toHaveLength(0);
	});
	test('rejects origin, content type, method, excess bytes and unexpected fields before backend calls', async () => {
		const h = harness();
		const invalidOrigins: RequestInit[] = [
			{ headers: { 'Content-Type': 'application/json' } },
			{ headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' } },
			{ headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } }
		];
		for (const init of invalidOrigins) expect((await h.post('session', {}, init)).response.status).toBe(403);
		expect((await h.post('session', {}, { headers: { Origin: origin, 'Content-Type': 'text/plain' } })).response.status).toBe(415);
		expect((await h.post('session', {}, { method: 'GET', body: undefined })).response.status).toBe(405);
		expect((await h.post('prepare', {}, { body: ' '.repeat(32769) })).response.status).toBe(413);
		expect((await h.post('session', {}, { body: '{bad' })).response.status).toBe(400);
		h.jar.set(CHECKOUT_COOKIE, root);
		expect((await h.post('prepare', { ...prepare, p_token: 'user-chosen' })).response.status).toBe(400);
		expect((await h.post('get', { ...binding, price: '1' })).response.status).toBe(400);
		expect(h.calls).toHaveLength(0);
	});
	test('bounds JSON types, decimal quantities, item uniqueness and contact length', () => {
		for (const body of [
			{ ...prepare, items: [{ product_id, quantity: 1 }] },
			{ ...prepare, items: [{ product_id, quantity: '1.0000001' }] },
			{ ...prepare, items: [{ product_id, quantity: '0' }] },
			{ ...prepare, items: [{ product_id, quantity: '1000000000000' }] },
			{ ...prepare, items: [] }, { ...prepare, items: [...prepare.items, ...prepare.items] },
			{ ...prepare, contact: 'x'.repeat(301) }, { ...prepare, contact: '\u0000' }
		]) expect(() => parsePrepareRequest(body)).toThrow();
		expect(parsePrepareRequest(prepare)).toEqual(prepare);
	});
	test('rate limits initialization and operations; missing bindings fail closed', async () => {
		const h = harness();
		h.config.sessionLimit.limit = async () => ({ success: false });
		const limited = await h.post('session', {});
		expect(limited.response.status).toBe(429);
		expect(limited.response.headers.get('retry-after')).toBe('60');
		h.jar.set(CHECKOUT_COOKIE, root);
		h.config.operationLimit.limit = async () => ({ success: false });
		expect((await h.post('get', binding)).response.status).toBe(429);
		h.config.origin = 'https://attacker.test/path';
		expect((await h.post('session', {})).response.status).toBe(503);
		expect(h.calls).toHaveLength(0);
	});
	test('same frozen retry derives the same server token; response exposes only reviewed fields', async () => {
		const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
		h.respond({ checkout_id, token: root });
		expect((await h.post('prepare', prepare)).body).toEqual({ checkout_id });
		await h.post('prepare', prepare);
		expect(h.calls[0]).toEqual(h.calls[1]);
		expect(h.calls[0]).toEqual({ name: 'checkout:prepare', args: {
			serverKey, requestId: request_id, token: await checkoutTokenForAttempt(root, request_id, binding.fingerprint),
			contact: prepare.contact, items: [{ productId: product_id, quantity: '0.000001' }]
		} });
		h.respond({ ...snapshot, token_digest: root });
		expect((await h.post('get', binding)).body).toEqual(snapshot);
		expect(h.calls[2]).toEqual({ name: 'checkout:get', args: { serverKey, checkoutId: checkout_id, token: h.calls[0].args.token } });
		expect(h.fetches).toHaveLength(0);
	});
	test('an unsafe deployment URL or short server key fails closed before any call', async () => {
		for (const patch of [{ convexUrl: 'http://deployment.example.test' }, { convexUrl: 'https://deployment.example.test/path' },
			{ convexUrl: 'https://user:pass@deployment.example.test' }, { serverKey: 'k'.repeat(31) }]) {
			const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
			Object.assign(h.config, patch);
			expect((await h.post('get', binding)).body).toEqual({ error: 'CHECKOUT_UNAVAILABLE' });
			expect(h.calls).toHaveLength(0);
		}
		const local = harness(); local.jar.set(CHECKOUT_COOKIE, root);
		local.config.convexUrl = 'http://127.0.0.1:3210';
		expect((await local.post('get', binding)).body).toEqual(snapshot);
	});
	test('invalid or mismatched snapshots cannot become payment instructions', async () => {
		const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
		for (const bad of [{ ...snapshot, checkout_id: product_id }, { ...snapshot, items: [] },
			{ ...snapshot, payment_required: false }, { ...snapshot, status: 'confirmed' }]) {
			h.respond(bad); expect((await h.post('get', binding)).response.status).toBe(503);
		}
		h.respond(snapshot); expect((await h.post('confirm', binding)).response.status).toBe(503);
		const confirmed = { ...snapshot, status: 'confirmed', confirmed_at: snapshot.created_at, registration_method: 'buyer' };
		h.respond(confirmed); expect((await h.post('confirm', binding)).body).toEqual(confirmed);
		expect(h.background).toHaveLength(0);
	});
	test('a registration sends the staff archive a receipt copy in the background', async () => {
		const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
		h.config.receipt = { resendApiKey: 're_test', limit: { limit: async () => ({ success: false }) } };
		const confirmed = { ...snapshot, status: 'confirmed', confirmed_at: snapshot.created_at, registration_method: 'buyer' };
		h.respond(confirmed); expect((await h.post('confirm', binding)).body).toEqual(confirmed);
		expect(await Promise.all(h.background)).toEqual([true]);
		expect(h.calls.map((call) => call.name)).toEqual(['checkout:confirm']);
		expect(h.fetches.map((call) => call.url)).toEqual(['https://api.resend.com/emails']);
		expect(JSON.parse(String(h.fetches[0].init?.body)).to).toEqual(['ampoteket.kvittering@outlook.com']);
	});
	test('receipts go only to a registered checkout, validated address and within the limit', async () => {
		const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
		const confirmed = { ...snapshot, status: 'confirmed', confirmed_at: snapshot.created_at, registration_method: 'buyer' };
		const request = { ...binding, email: ' buyer@example.test ' };
		expect((await h.post('receipt', request)).body).toEqual({ error: 'RECEIPT_UNAVAILABLE' });
		let allowed = true;
		h.config.receipt = { resendApiKey: 're_test', limit: { limit: async () => ({ success: allowed }) } };
		expect((await h.post('receipt', { ...binding, email: '98765432' })).response.status).toBe(400);
		expect((await h.post('receipt', { ...binding, email: 'a@b.no', extra: 1 })).response.status).toBe(400);
		expect(h.calls).toHaveLength(0);
		h.respond(snapshot); expect((await h.post('receipt', request)).body).toEqual({ error: 'CHECKOUT_NOT_REGISTERED' });
		h.respond(confirmed); expect((await h.post('receipt', request)).body).toEqual({ sent: true });
		expect(h.calls.map((call) => call.name)).toEqual(['checkout:get', 'checkout:get']);
		expect(h.fetches.map((call) => call.url)).toEqual(['https://api.resend.com/emails']);
		expect(JSON.parse(String(h.fetches[0].init?.body)).to).toEqual(['buyer@example.test']);
		allowed = false; expect((await h.post('receipt', request)).response.status).toBe(429);
		allowed = true; h.reject(new Error('fetch failed'));
		expect((await h.post('receipt', request)).response.status).toBe(503);
	});
	test('backend rejections never leak details, tokens or contact', async () => {
		const h = harness(); h.jar.set(CHECKOUT_COOKIE, root);
		h.reject(rejection('PRODUCT_NOT_FOR_SALE', `PRODUCT_NOT_FOR_SALE: ${root}`));
		const refused = await h.post('prepare', prepare);
		expect(refused.response.status).toBe(409);
		expect(refused.body).toEqual({ error: 'PRODUCT_NOT_FOR_SALE' });
		h.reject(rejection('CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED'));
		const forbidden = await h.post('get', binding);
		expect(forbidden.response.status).toBe(403);
		expect(forbidden.body).toEqual({ error: 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED' });
		// A wrong server key, an unknown rejection, an outage or a server bug: the outcome is unknown.
		for (const error of [rejection('CHECKOUT_SERVER_REQUIRED'), rejection('SOMETHING_NEW', root), new Error(`Server error: ${root}`)]) {
			h.reject(error);
			const unavailable = await h.post('confirm', binding);
			expect(unavailable.response.status).toBe(503);
			expect(unavailable.body).toEqual({ error: 'CHECKOUT_UNAVAILABLE' });
		}
	});
	test('zero totals require the saved flag and valid nonempty immutable items', () => {
		const free = { ...snapshot, total_nok: '0.00', payment_required: false,
			items: [{ ...snapshot.items[0], unit_price_nok: '0.000001', line_total_nok: '0.00' }] };
		expect(parseCheckoutSnapshot(free)).toEqual(free);
		expect(() => parseCheckoutSnapshot({ ...free, payment_required: true })).toThrow();
	});
});
