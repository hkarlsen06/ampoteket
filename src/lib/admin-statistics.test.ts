import { expect, test } from 'bun:test';
import { readAdminStatistics, salesAxis } from './admin-statistics';
import type { StaffSession } from './admin-api';

test('sales axes show whole purchase counts with headroom and preserve exact quantities', () => {
	expect(salesAxis(['0', '1'])).toEqual({ points: [0, 500], maximum: '1', ticks: [{ point: 0, value: '0' }, { point: 500, value: '1' }, { point: 1000, value: '2' }] });
	expect(salesAxis(['0', '0.000001', '0.000002'], false)).toMatchObject({ points: [0, 500, 1000], maximum: '0.000002' });
	expect(salesAxis(['9007199254740992', '9007199254740993'])).toMatchObject({ points: [900, 900], maximum: '9007199254740993' });
	expect(salesAxis(['0.00', '0']).ticks.map(tick => tick.value)).toEqual(['0', '1', '2']);
	expect(salesAxis(['12']).ticks.map(tick => tick.value)).toEqual(['0', '5', '10', '15']);
	expect(() => salesAxis(['-1'])).toThrow('NEGATIVE_SALES');
	expect(() => salesAxis(['1e3'])).toThrow('INVALID_DECIMAL');
});

test('statistics preserve exact strings and reject incomplete or mismatched reports', async () => {
	const productId = '10000000-0000-4000-8000-000000000001';
	const session: StaffSession = { config: { url: 'https://example.test', publishableKey: 'public' }, token: 'staff-jwt', userId: productId };
	const summary = { sale_count: '1', total_nok: '9007199254740993.01', quantity: '0.000001' };
	const report = { product_id: productId, start_date: '2026-03-01', end_date: '2026-03-30', summary,
		days: Array.from({ length: 30 }, (_, index) => ({ date: `2026-03-${String(index + 1).padStart(2, '0')}`, ...summary })), products: [], overview: null };
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(String(input)).toBe('https://example.test/rest/v1/rpc/amp_admin_statistics');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer staff-jwt');
		expect(JSON.parse(String(init?.body))).toEqual({ p_product_id: productId });
		return new Response(JSON.stringify(report));
	};
	expect((await readAdminStatistics(session, productId, fetcher)).summary).toEqual(summary);
	report.days.pop();
	await expect(readAdminStatistics(session, productId, fetcher)).rejects.toThrow('Incomplete statistics period');
	report.product_id = '10000000-0000-4000-8000-000000000002';
	await expect(readAdminStatistics(session, productId, fetcher)).rejects.toThrow('Invalid statistics product');
	const invalidNumber = async () => new Response(JSON.stringify({ ...report, product_id: productId, days: [{ ...report.days[0], total_nok: 'NaN' }] }));
	await expect(readAdminStatistics(session, productId, invalidNumber)).rejects.toThrow('Invalid statistics number');
});
