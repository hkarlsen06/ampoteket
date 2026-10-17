/** Test-only fixture. Never imported by SvelteKit or deployed as the shop. */
import { newCheckoutSessionSecret, checkoutSessionFingerprint, checkoutTokenForAttempt } from '../../src/lib/server/checkout-credentials';
import { ConvexHttpClient } from 'convex/browser';
import { readCatalogPage } from '../../src/lib/catalog';

type ProofEnv = { CONVEX_URL: string; ASSETS: { fetch(request: Request): Promise<Response> } };
const cookieName = '__Host-amp_checkout';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

export default {
	async fetch(request: Request, env: ProofEnv) {
		const url = new URL(request.url);
		// The browser talks to the disposable Convex backend directly, as the shop does.
		if (url.pathname === '/proof/config') return Response.json({ url: env.CONVEX_URL }, { headers });
		if (url.pathname === '/proof/catalog') return Response.json(await readCatalogPage(new ConvexHttpClient(env.CONVEX_URL, { logger: false }), { limit: 2 }), { headers });
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
