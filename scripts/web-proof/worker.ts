/** Test-only fixture. Never imported by SvelteKit or deployed as the shop. */
import { newCheckoutSessionSecret, checkoutSessionFingerprint, checkoutTokenForAttempt } from '../../src/lib/server/checkout-credentials';
import { readCatalogPage } from '../../src/lib/catalog';

type ProofEnv = { API_URL: string; PUBLISHABLE_KEY: string; ASSETS: { fetch(request: Request): Promise<Response> } };
const cookieName = '__Host-amp_checkout';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

export default {
	async fetch(request: Request, env: ProofEnv) {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/rest/v1/')) {
			// This isolated same-origin proxy needs no service key. Forward the
			// browser's own Auth/public credential to its disposable local API.
			const target = new URL(env.API_URL);
			if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('Nonlocal proof API');
			target.pathname = url.pathname;
			target.search = url.search;
			const forwarded = new Headers(request.headers);
			forwarded.delete('cookie');
			forwarded.delete('host');
			const response = await fetch(target, { method: request.method, headers: forwarded, body: request.body, redirect: 'manual' });
			if (response.status >= 300 && response.status < 400) return new Response(null, { status: 502, headers });
			const result = new Response(response.body, response);
			result.headers.set('Cache-Control', 'no-store');
			return result;
		}
		if (url.pathname === '/proof/config') return Response.json({ url: url.origin, publishableKey: env.PUBLISHABLE_KEY }, { headers });
		if (url.pathname === '/proof/catalog') return Response.json(await readCatalogPage({
			url: env.API_URL, publishableKey: env.PUBLISHABLE_KEY
		}), { headers });
		if (url.pathname === '/proof/session' || url.pathname === '/proof/binding') {
			if (request.method !== 'POST') return new Response(null, { status: 405, headers });
			if (request.headers.get('Origin') !== url.origin) return new Response(null, { status: 403, headers });
			const secret = request.headers.get('Cookie')?.split('; ').find((item) => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
			try {
				if (url.pathname === '/proof/session') {
					const root = secret ?? newCheckoutSessionSecret();
					const fingerprint = await checkoutSessionFingerprint(root);
					return Response.json({ fingerprint }, { headers: { ...headers,
						'Set-Cookie': `${cookieName}=${root}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
					} });
				}
				const body = await request.json() as { requestId: string; fingerprint: string };
				await checkoutTokenForAttempt(secret, body.requestId, body.fingerprint);
				return Response.json({ bound: true }, { headers });
			} catch {
				return Response.json({ bound: false }, { status: 409, headers });
			}
		}
		return env.ASSETS.fetch(request);
	}
};
