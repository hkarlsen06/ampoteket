import { expect, mock, test } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';

mock.module('$env/dynamic/private', () => ({ env: {} }));
const { handle } = await import('./hooks.server');

test('production redirects HTTP and www before resolving, retaining path and query', async () => {
	for (const base of ['http://ampoteket.no', 'http://www.ampoteket.no', 'https://www.ampoteket.no']) {
		const response = await handle({
			event: { url: new URL(`${base}/en/admin/password?token_hash=one-use-token`), route: { id: '/[[locale=locale]]/admin/password' } } as RequestEvent,
			resolve: async () => { throw new Error('insecure page must not render'); }
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('Location')).toBe('https://ampoteket.no/en/admin/password?token_hash=one-use-token');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
		expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
	}
});

test('HTTPS gains HSTS without broadening private headers or redirecting development', async () => {
	for (const [base, path, privatePage] of [
		['https://ampoteket.no', '/help', false],
		['https://ampoteket.no', '/en/admin/login', true],
		['http://localhost:5174', '/help', false]
	] as const) {
		const response = await handle({
			event: { url: new URL(base + path), route: { id: privatePage ? '/[[locale=locale]]/admin/login' : '/[[locale=locale]]/help' } } as RequestEvent,
			resolve: async () => new Response('page', { headers: { 'Cache-Control': 'public, max-age=60' } })
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Strict-Transport-Security')).toBe(base.startsWith('https:') ? 'max-age=31536000' : null);
		expect(response.headers.get('Cache-Control')).toBe(privatePage ? 'no-store' : 'public, max-age=60');
		expect(response.headers.get('Referrer-Policy')).toBe(privatePage ? 'no-referrer' : null);
	}
});
