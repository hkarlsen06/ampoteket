// Staff statistics (api-contract.md "Staff statistics").
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, guest, product, rejected, serverKey, staff, uuid } from './harness';

describe.skipIf(!enabled)('statistics', () => {
	beforeEach(freshDeployment);

	test('registered sales today count with per-line rounding; attention lists sold-out before below-minimum', async () => {
		const { client } = await staff();
		const cheap = await product(client, { sale_unit_price_nok: '0.333333' });
		const low = await product(client, { minimum_stock: '10' });
		await client.mutation(api.stock.recordSingleCount, { requestId: uuid(), productId: low.id, expectedRevision: '0', counted: '4', note: null });
		const token = 'cd'.repeat(32);
		const { checkout_id } = await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token, contact: null, items: [{ productId: cheap.id, quantity: '3' }] });
		// An unconfirmed checkout never counts.
		await guest().mutation(api.checkout.prepare, { serverKey, requestId: uuid(), token: 'ef'.repeat(32), contact: null, items: [{ productId: cheap.id, quantity: '9' }] });
		await guest().mutation(api.checkout.confirm, { serverKey, checkoutId: checkout_id, token });

		const all = await client.query(api.statistics.read, { productId: null });
		expect(all.days).toHaveLength(30);
		expect(all.days.at(-1)).toMatchObject({ date: all.end_date, sale_count: '1', total_nok: '1.00', quantity: null });
		expect(all.summary).toEqual({ sale_count: '1', total_nok: '1.00', quantity: null });
		expect(all.products).toEqual([expect.objectContaining({ product_id: cheap.id, sale_count: '1', quantity: '3', total_nok: '1.00' })]);
		// cheap is at -3 (sold out, negative first), low is 4 of a minimum of 10.
		expect(all.overview?.attention.map((p) => p.product_id)).toEqual([cheap.id, low.id]);
		expect(all.overview?.attention_count).toBe('2');

		const one = await client.query(api.statistics.read, { productId: cheap.id });
		expect(one.summary).toEqual({ sale_count: '1', total_nok: '1.00', quantity: '3' });
		expect(one.overview).toBeNull();
		expect(await rejected(client.query(api.statistics.read, { productId: uuid() }))).toBe('PRODUCT_NOT_FOUND');
	});
});
