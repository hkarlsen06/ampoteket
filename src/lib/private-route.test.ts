import { expect, test } from 'bun:test';
import { isPrivateRoute } from './private-route';

test('resolved private routes stay private through encoded URLs and locale prefixes', () => {
	for (const [route, path] of [
		['/[[locale=locale]]/admin/login', '/%61dmin/login'],
		['/[[locale=locale]]/checkout/[id]', '/en/%63heckout/saved-reference'],
		['/api/checkouts/[id]/confirm', '/api/%63heckouts/saved-reference/confirm']
	]) expect(isPrivateRoute(route, path)).toBe(true);
});

test('unmatched private paths retain protection without widening public routes', () => {
	for (const path of ['/checkout/missing/path', '/%65n/%61dmin/missing', '/api/%63heckouts/missing', '/admin/%invalid']) {
		expect(isPrivateRoute(null, path)).toBe(true);
	}
	for (const path of ['/en/p', '/help', '/administer', '/checkout-guide', '/api/checkouts-extra', '/%invalid']) {
		expect(isPrivateRoute(null, path)).toBe(false);
	}
});
