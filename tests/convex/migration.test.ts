// The Supabase import (scripts/convex-cutover/import.ts) on a synthetic export
// shaped exactly like export.sql's output: lossless numbers, variable-precision
// timestamps with offsets, \x bytea, jsonb images and a Go-style $2a$ bcrypt hash.
import { beforeEach, describe, expect, test } from 'bun:test';
import bcrypt from 'bcryptjs';
import { LosslessNumber, parse, stringify } from 'lossless-json';
import { api } from '../../convex/_generated/api';
import { digest, transform, verify, type Export } from '../../scripts/convex-cutover/import';
import { enabled, guest, internal, rejected, signedIn } from './harness';

const ids = { staff: '11111111-1111-4111-8111-111111111111', user: '22222222-2222-4222-8222-222222222222', product: '33333333-3333-4333-8333-333333333333',
	event1: '44444444-4444-4444-8444-444444444441', event2: '44444444-4444-4444-8444-444444444442', batch: '55555555-5555-4555-8555-555555555555',
	request: '66666666-6666-4666-8666-666666666666', cabinet: '77777777-7777-4777-8777-777777777777', bin: '88888888-8888-4888-8888-888888888888',
	category: '99999999-9999-4999-8999-999999999999', definition: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const password = 'the old supabase password';
/** A numeric token written exactly as PostgreSQL's to_json writes it. */
const n = (text: string) => new LosslessNumber(text);

function syntheticExport(): string {
	const hash = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, '$2a$');
	return stringify({
		exported_at: '2026-10-17T12:00:00.123456+00:00', migrations: ['20260917000100'],
		tables: {
			units: [{ code: 'pcs', name: 'Piece', symbol: 'stk', is_discrete: true }],
			staff_members: [{ id: ids.staff, auth_user_id: ids.user, display_name: 'Hjalmar', is_active: true, created_at: '2026-09-20T10:00:00.12+00:00' }],
			help_contacts: [], categories: [{ id: ids.category, name: 'Capacitors' }],
			cabinets: [{ id: ids.cabinet, code: 'C-1', outer_row: 1, outer_col: 1, inner_rows: 2, inner_cols: 2, label: null, is_archived: false }],
			bins: [{ id: ids.bin, code: 'B-1', cabinet_id: ids.cabinet, inner_row: 1, inner_col: 1, row_span: 1, col_span: 2, label: 'Caps', is_archived: false }],
			products: [{ id: ids.product, code: 'CAP-7B5E0', name_nb: 'Kondensator 0,5 pF', name_en: 'Capacitor 0.5 pF', description: null, category_id: ids.category,
				bin_id: ids.bin, location_note: null, unit_code: 'pcs', stock_step: n('1'), sale_step: n('1'), sale_unit_price_nok: n('0.50'), minimum_stock: n('10'),
				datasheet_url: null, purchase_url: null, is_active: true, metadata_revision: 3, created_at: '2026-09-21T08:00:00.5+00:00', updated_at: '2026-10-14T13:33:00.987654+00:00' }],
			attribute_definitions: [{ id: ids.definition, code: 'capacitance', label: 'Capacitance', value_type: 'number', canonical_unit: 'F' }],
			product_attributes: [{ product_id: ids.product, attribute_id: ids.definition, number_value: n('0.0000000000005'), text_value: null, boolean_value: null, number_max: null }],
			command_requests: [{ id: ids.request, command_name: 'record_single_count', actor_id: ids.staff, request_digest: '\\x' + 'ab'.repeat(32),
				result: { batch_id: ids.batch, quantity: '40', difference: '40', event_id: ids.event1 }, created_at: '2026-09-22T09:00:00+00:00' }],
			purchase_orders: [], purchase_order_lines: [], purchase_order_cancellations: [], checkouts: [], checkout_lines: [], checkout_contacts: [],
			count_batches: [{ id: ids.batch, request_id: ids.request, owner_id: ids.staff, title: 'CAP-7B5E0', started_at: '2026-09-22T09:00:00.000001+00:00',
				finished_at: '2026-09-22T09:00:00.000001+00:00', finished_by: ids.staff, finish_reason: null, product_id: ids.product }],
			inventory_events: [
				{ id: ids.event1, request_id: ids.request, kind: 'count', actor_id: ids.staff, purchase_order_id: null, note: null, occurred_at: '2026-09-22T09:00:00.000001+00:00', recorded_at: '2026-09-22T09:00:00.000001+00:00' },
				{ id: ids.event2, request_id: null, kind: 'adjustment', actor_id: ids.staff, purchase_order_id: null, note: 'Found more', occurred_at: '2026-09-23T09:00:00.1234+00:00', recorded_at: '2026-09-23T09:00:00.1234+00:00' }],
			inventory_movements: [{ id: 7, event_id: ids.event1, product_id: ids.product, quantity_delta: n('40') }, { id: 164, event_id: ids.event2, product_id: ids.product, quantity_delta: n('-2.000') }],
			movement_corrections: [], receipt_allocations: [], sales: [],
			stock_counts: [{ event_id: ids.event1, batch_id: ids.batch, product_id: ids.product, expected_quantity: n('0'), counted_quantity: n('40'), expected_revision: 0 }],
			audit_log: [{ id: 646, table_name: 'products', row_key: { id: ids.product }, action: 'UPDATE', before_data: { id: ids.product, sale_unit_price_nok: n('0.40'), outer_row: n('1') },
				after_data: { id: ids.product, sale_unit_price_nok: n('0.50'), outer_row: n('1') }, actor_id: null, database_role: 'postgres', recorded_at: '2026-10-14T13:33:00.987654+00:00' }]
		},
		users: [{ id: ids.user, email: 'Hjalmar@Example.no', encrypted_password: hash, email_confirmed_at: '2026-10-01T10:00:00.1+00:00' }],
		inventory: [{ code: 'CAP-7B5E0', quantity: n('38.000'), revision: n('164'), last_counted_at: '2026-09-22T09:00:00.000001+00:00' }]
	})!;
}

describe.skipIf(!enabled)('Supabase import', () => {
	beforeEach(async () => {
		for (const table of ['units', 'staff_members', 'categories', 'cabinets', 'bins', 'products', 'attribute_definitions', 'product_attributes', 'command_requests',
			'count_batches', 'inventory_events', 'inventory_movements', 'stock_counts', 'audit_log', 'stock_levels', 'counters', 'users', 'authAccounts',
			'authSessions', 'authRefreshTokens', 'authRateLimits', 'help_contacts', 'checkouts', 'checkout_lines', 'checkout_contacts', 'sales', 'purchase_orders',
			'purchase_order_lines', 'purchase_order_cancellations', 'movement_corrections', 'receipt_allocations', 'password_tokens', 'rate_limits']) {
			while (await internal<number>('mutation', 'migration:resetForRehearsal', { table }) > 0) { /* until empty */ }
		}
	});

	test('values are kept exactly; the import verifies; the old password still signs in; sequences continue', async () => {
		const data = parse(syntheticExport()) as Export;
		const { tables, users, inventory } = transform(data);
		expect(tables.products[0]).toMatchObject({ sale_unit_price_nok: '0.50', minimum_stock: '10', created_at: '2026-09-21T08:00:00.500000Z', metadata_revision: 3 });
		expect(tables.product_attributes[0].number_value).toBe('0.0000000000005');
		expect(tables.inventory_movements[1]).toMatchObject({ id: 164, quantity_delta: '-2.000' });
		expect(tables.command_requests[0].request_digest).toBe('ab'.repeat(32));
		expect(tables.audit_log[0]).toMatchObject({ row_id: ids.product, before_data: { sale_unit_price_nok: '0.40', outer_row: '1' } });
		expect(users[0]).toMatchObject({ email: 'hjalmar@example.no', auth_user_id: ids.user });

		for (const [table, rows] of Object.entries(tables)) await internal('mutation', 'migration:insertRows', { table, rows, first: true });
		await internal('mutation', 'migration:insertUsers', { users });
		await internal('mutation', 'migration:setSequences');
		await internal('mutation', 'migration:rebuildStockLevels', { productIds: [ids.product] });
		expect(await verify(tables, inventory, (name, args) => internal('query', name, args))).toEqual([]);
		expect(await digest(tables.products)).toBe((await internal<{ digest: string }>('query', 'migration:tableDigest', { table: 'products' })).digest);
		// Importing twice is refused rather than duplicating rows.
		expect(String(await internal('mutation', 'migration:insertRows', { table: 'products', rows: tables.products, first: true }).catch((e) => e)))
			.toContain('IMPORT_TARGET_NOT_EMPTY');

		const admin = await signedIn('hjalmar@example.no', password);
		const me = await admin.query(api.members.me, {});
		expect(me).toMatchObject({ authUserId: ids.user, membership: { id: ids.staff, displayName: 'Hjalmar' } });
		expect(await rejected(guest().action(api.session.signIn, { email: 'hjalmar@example.no', password: 'not it at all' }))).toBe('INVALID_CREDENTIALS');
		// The next movement continues after the imported maximum (164) and keeps the balance exact.
		await admin.mutation(api.stock.adjust, { requestId: crypto.randomUUID(), items: [{ productId: ids.product, quantityDelta: '2' }], reason: 'After cutover' });
		const detail = await admin.query(api.stock.detail, { productId: ids.product });
		expect(detail.stock).toMatchObject({ quantity: '40', revision: '165' });
		expect(await rejected(admin.mutation(api.stock.recordSingleCount, { requestId: crypto.randomUUID(), productId: ids.product, expectedRevision: '164', counted: '40', note: null })))
			.toBe('STALE_STOCK_COUNT');
		// The public catalog shows the imported product with its exact value.
		const page = await guest().query(api.catalog.page, { limit: 10 });
		expect(page.products[0]).toMatchObject({ code: 'CAP-7B5E0', quantity: '40', sale_unit_price_nok: '0.50' });
		expect(page.products[0].attributes.capacitance).toMatchObject({ value: '0.0000000000005' });
	});
});
