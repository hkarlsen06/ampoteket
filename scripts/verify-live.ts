/** Read-only HTTP smoke check of https://ampoteket.no in both locales; expectations follow wrangler.jsonc. */
import { unstable_readConfig } from 'wrangler';
import { nb } from '../src/lib/i18n/nb';
import { en } from '../src/lib/i18n/en';

const origin = 'https://ampoteket.no';
const salesOpen = unstable_readConfig({ env: 'production' }).vars.SALES_OPEN === 'true';
const options = { redirect: 'manual' as const, headers: { 'Cache-Control': 'no-cache' } };
const get = (url: string, init: RequestInit = {}) => fetch(url, { ...options, ...init, signal: AbortSignal.timeout(15000) });
const failures: string[] = [];
let checks = 0;
const check = (ok: boolean, problem: string) => { checks++; if (!ok) failures.push(problem); };

const buyerPages: [string, number][] = salesOpen ? [['/p', 200], ['/cart', 200]] : [['/p', 503], ['/cart', 503], ['/checkout', 503], ['/p/RES-00001', 503]];
for (const prefix of ['', '/en']) {
	for (const [path, expected] of [['/', 200], ['/contact', 200], ['/privacy', 200], ['/admin', 200], ['/admin/login', 200], ['/admin/password', 200], ...buyerPages] as [string, number][]) {
		const url = origin + (path === '/' ? prefix || '/' : prefix + path);
		const response = await get(url);
		const body = await response.text();
		check(response.status === expected, `${url}: HTTP ${response.status}, expected ${expected}`);
		check(response.headers.get('strict-transport-security') === 'max-age=31536000', `${url}: HSTS missing`);
		if (path.startsWith('/admin') || path === '/checkout') {
			check(response.headers.get('cache-control') === 'no-store' && response.headers.get('referrer-policy') === 'no-referrer', `${url}: private headers missing`);
		}
		if (path === '/contact') check(!body.includes((prefix ? en : nb).help.unavailable), `${url}: contact list unavailable`);
	}
	const help = await get(`${origin}${prefix}/help`);
	await help.body?.cancel();
	check(help.status === 308 && help.headers.get('location') === `${prefix}/contact`, `${prefix}/help does not redirect to ${prefix}/contact`);
}

for (const base of ['http://ampoteket.no', 'http://www.ampoteket.no', 'https://www.ampoteket.no']) {
	const path = '/en/admin/password?next=%2Fadmin%2Fstatistics';
	const response = await get(base + path);
	await response.body?.cancel();
	check(response.status === 308 && response.headers.get('location') === origin + path
		&& response.headers.get('cache-control') === 'no-store' && response.headers.get('referrer-policy') === 'no-referrer', `${base}: no private redirect to ${origin}`);
}

if (!salesOpen) {
	for (const endpoint of ['session', 'prepare']) {
		const response = await get(`${origin}/api/checkouts/${endpoint}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
		const body = await response.text();
		check(response.status === 503 && body.includes('CHECKOUT_UNAVAILABLE'), `/api/checkouts/${endpoint}: HTTP ${response.status}, expected 503 CHECKOUT_UNAVAILABLE`);
	}
}

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}
console.log(`PASS: ${checks} live HTTP checks, both locales, sales ${salesOpen ? 'open' : 'closed'}.`);
