// Development and proof seed data (convex/seed.ts, scripts/seed-test-data.ts).
import { beforeAll, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { DEMO_PARTS, seedDemoData, seedProductCode } from '../../scripts/seed-test-data';
import { enabled, freshDeployment, guest, internal } from './harness';

describe.skipIf(!enabled)('demo seed', () => {
	beforeAll(freshDeployment);

	test('seeds products with stock through the ledger, idempotently', async () => {
		const run = (kind: 'mutation', name: string, args: Record<string, unknown>) => internal(kind, name, args);
		await seedDemoData(run, 60);
		await seedDemoData(run, 60);
		const all: unknown[] = [];
		let afterCode: string | undefined;
		for (;;) {
			const page = await guest().query(api.catalog.page, { limit: 200, ...(afterCode ? { afterCode } : {}) });
			all.push(...page.products);
			if (page.complete) break;
			afterCode = page.nextAfterCode!;
		}
		expect(all).toHaveLength(60);
		expect(await internal<string[]>('query', 'migration:verifyStockLevels')).toEqual([]);
		const cable = (await guest().query(api.catalog.product, { code: seedProductCode(DEMO_PARTS.length - 1) }))!;
		expect(cable).toMatchObject({ unit_code: 'm', quantity: '12.345', sale_unit_price_nok: '12.345678' });
	});
});
