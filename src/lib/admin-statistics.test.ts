import { expect, test } from 'bun:test';
import { readAdminStatistics, salesAxis } from './admin-statistics';
import { getFunctionName } from 'convex/server';
import type { ConvexCaller, StaffSession } from './convex';

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
	const summary = { sale_count: '1', total_nok: '9007199254740993.01', quantity: '0.000001' };
	const report = { product_id: productId, start_date: '2026-03-01', end_date: '2026-03-30', summary,
		days: Array.from({ length: 30 }, (_, index) => ({ date: `2026-03-${String(index + 1).padStart(2, '0')}`, ...summary })), products: [], overview: null };
	let reply: unknown = report;
	const client = { query: async (fn: never, args: unknown) => {
		expect(getFunctionName(fn)).toBe('statistics:read');
		expect(args).toEqual({ productId });
		return reply;
	} } as unknown as ConvexCaller;
	const session: StaffSession = { client, userId: productId };
	expect((await readAdminStatistics(session, productId)).summary).toEqual(summary);
	report.days.pop();
	await expect(readAdminStatistics(session, productId)).rejects.toThrow('Incomplete statistics period');
	report.product_id = '10000000-0000-4000-8000-000000000002';
	await expect(readAdminStatistics(session, productId)).rejects.toThrow('Invalid statistics product');
	reply = { ...report, product_id: productId, days: [{ ...report.days[0], total_nok: 'NaN' }] };
	await expect(readAdminStatistics(session, productId)).rejects.toThrow('Invalid statistics number');
	await expect(readAdminStatistics(session, 'not-a-product')).rejects.toThrow();
});
