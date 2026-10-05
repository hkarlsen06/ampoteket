import { expect, test } from 'bun:test';
import { describeAudit, readAuditReferences, readAuditPage, readAuditUpdates, type AuditEntry, type AuditReferences } from './admin-audit';

const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-jwt', userId: '11111111-1111-4111-8111-111111111111' };
const entry = (id: string) => ({ id, table_name: 'products', row_key: { id: session.userId }, action: 'UPDATE', before_data: { sale_unit_price_nok: '9007199254740993.123456' }, after_data: { sale_unit_price_nok: '9007199254740994.123456' }, actor_id: session.userId, database_role: 'authenticated', recorded_at: '2026-09-23T10:00:00Z' });

test('audit refresh reads every new entry across capped pages without repeating the visible head', async () => {
	const newest = 9007199254740994n;
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const cursor = BigInt(url.searchParams.get('id')?.slice(3) ?? String(newest + 46n));
		const count = Math.min(Number(url.searchParams.get('limit')), 7);
		return new Response(JSON.stringify(Array.from({ length: count }, (_, index) => entry(String(cursor - BigInt(index + 1))))));
	};
	const updates = await readAuditUpdates(session, String(newest), fetcher);
	expect(updates.map(row => row.id)).toEqual(Array.from({ length: 45 }, (_, index) => String(newest + 45n - BigInt(index))));
	expect(await readAuditUpdates(session, String(newest + 45n), fetcher)).toEqual([]);
});

test('audit paging retains exact nested values and fills capped responses without skipping an ID', async () => {
	const calls: string[] = [];
	const fetcher = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		calls.push(url.searchParams.get('id') ?? '');
		const cursor = url.searchParams.get('id')?.slice(3) ?? '9007199254741024';
		const count = Math.min(Number(url.searchParams.get('limit')), 7);
		const rows = Array.from({ length: count }, (_, index) => entry((BigInt(cursor) - BigInt(index + 1)).toString()));
		return new Response(JSON.stringify(rows).replaceAll('"9007199254740993.123456"', '9007199254740993.123456'));
	};
	const first = await readAuditPage(session, null, fetcher);
	expect(first.entries).toHaveLength(30);
	expect(first.more).toBe(true);
	expect(first.entries[0].before?.sale_unit_price_nok).toBe('9007199254740993.123456');
	expect(first.entries.at(-1)?.id).toBe('9007199254740994');
	expect(calls.length).toBeGreaterThan(4);
	let read = false;
	const next = await readAuditPage(session, first.entries.at(-1)!.id, async (input) => {
		const url = new URL(String(input));
		if (!read) expect(url.searchParams.get('id')).toBe('lt.9007199254740994');
		read = true;
		return new Response(JSON.stringify(read && url.searchParams.get('id') === 'lt.9007199254740994' ? [entry('9007199254740993')] : []));
	});
	expect(next.entries[0].id).toBe('9007199254740993');
});

const audit = (table: string, before: AuditEntry['before'], after: AuditEntry['after'], actorId: string | null = session.userId, role = 'authenticated'): AuditEntry => ({ id: '569', table, key: { id: session.userId }, action: before ? after ? 'UPDATE' : 'DELETE' : 'INSERT', before, after, actorId, role, recordedAt: '2026-09-23T10:00:00Z' });
const references: AuditReferences = {
	staff_members: { [session.userId]: { display_name: 'Ada' } },
	products: { [session.userId]: { code: 'RES-01', name_nb: 'Motstand', name_en: 'Resistor', unit_code: 'pcs' } },
	categories: { [session.userId]: { name: 'Resistors' } },
	cabinets: { [session.userId]: { outer_row: '2', outer_col: '3' } },
	bins: { [session.userId]: { cabinet_id: session.userId, inner_row: '1', inner_col: '1', col_span: '4', row_span: '1' } },
	attribute_definitions: { [session.userId]: { code: 'resistance', label: 'Resistance', value_type: 'number', canonical_unit: 'ohm' } },
	purchase_orders: { [session.userId]: { supplier_name: 'Supplier', supplier_reference: 'REF-01' } }
};

test('audit descriptions localize actors and subjects without exposing identifiers or roles', () => {
	const product = { ...references.products[session.userId], id: session.userId, metadata_revision: '2', category_id: session.userId, bin_id: session.userId, is_active: true };
	const described = describeAudit(audit('products', null, product), 'nb', references);
	expect(described.subject).toBe('Produkt: RES-01 · Motstand');
	expect(described.actor).toBe('Ada');
	expect(described.fields).toContainEqual({ label: 'Kategori', before: null, after: 'Motstand' });
	expect(described.fields).toContainEqual({ label: 'Skuff', before: null, after: 'C2 / A1–D1' });
	expect(described.fields).toContainEqual({ label: 'Publisering', before: null, after: 'Publisert' });
	expect(JSON.stringify(described)).not.toContain(session.userId);
	for (const role of ['postgres', 'supabase_admin', 'anon']) expect(describeAudit(audit('count_batches', null, { title: 'Friday count' }, null, role), 'en').actor).toBe('System');
	expect(describeAudit(audit('count_batches', null, { title: 'Friday count' }), 'en').actor).toBe('Unknown admin');
	expect(describeAudit(audit('checkout_contacts', null, null, null, 'service_role'), 'nb').actor).toBe('Selvbetjent kjøp');
	expect(describeAudit(audit('unexpected_table', null, { secret_id: session.userId }), 'en').subject).toBe('Unknown entry');
});

test('audit diffs keep money and quantities exact, translate states and keep unresolved references as Unknown', () => {
	const old = { ...references.products[session.userId], sale_unit_price_nok: '9007199254740993.123456', minimum_stock: '0', is_active: false, updated_at: '2026-09-23T10:00:00Z', metadata_revision: '1', bin_id: null };
	const now = { ...old, sale_unit_price_nok: '9007199254740994.123456', minimum_stock: '2', is_active: true, metadata_revision: '2', bin_id: session.userId };
	expect(describeAudit(audit('products', old, now), 'en').fields).toEqual([
		{ label: 'Drawer', before: 'Not set', after: 'Unknown' },
		{ label: 'Sales price', before: '9,007,199,254,740,993.123456 NOK', after: '9,007,199,254,740,994.123456 NOK' },
		{ label: 'Minimum stock', before: '0 pieces', after: '2 pieces' },
		{ label: 'Publication', before: 'Unpublished', after: 'Published' }
	]);
	const count = describeAudit(audit('count_batches', { title: 'Friday count', finished_at: null }, { title: 'Friday count', finished_at: '2026-09-23T10:00:00Z' }), 'en');
	expect(count.subject).toBe('Stock count: Friday count');
	expect(count.fields[0]).toEqual({ label: 'Finished', before: 'Not set', after: '23 Sept 2026, 12:00' });
	const spec = describeAudit(audit('product_attributes', { product_id: session.userId, attribute_id: session.userId, number_value: '1000' }, { product_id: session.userId, attribute_id: session.userId, number_value: '2000' }), 'nb', references);
	expect(spec.subject).toBe('Produktspesifikasjon: RES-01 · Motstand · Resistans');
	expect(spec.fields).toEqual([{ label: 'Verdi', before: '1 kΩ', after: '2 kΩ' }]);
	expect(describeAudit(audit('help_contacts', { phone: '12345678' }, { phone: '87654321' }), 'en').fields).toEqual([{ label: 'Phone', before: '12345678', after: '87654321' }]);
	// Created and deleted rows list only the fields they had; an update still shows a cleared field.
	expect(describeAudit(audit('count_batches', null, { title: 'Friday count', finished_at: null }), 'en').fields).toEqual([{ label: 'Title', before: null, after: 'Friday count' }]);
	expect(describeAudit(audit('count_batches', { title: 'Friday count', finished_at: null }, null), 'en').fields).toEqual([{ label: 'Title', before: 'Friday count', after: null }]);
	expect(describeAudit(audit('help_contacts', { phone: '12345678' }, { phone: null }), 'en').fields).toEqual([{ label: 'Phone', before: '12345678', after: 'Not set' }]);
});

test('every audited table has a readable subject, including deletes and archived storage', () => {
	const cases: [string, Record<string, unknown>, string][] = [
		['staff_members', { display_name: 'Ada' }, 'Admin: Ada'], ['help_contacts', { display_name: 'Ada' }, 'Contact: Ada'],
		['units', { code: 'pcs', name: 'Piece' }, 'Unit: pcs'], ['categories', { name: 'Resistors' }, 'Category: Resistor'],
		['cabinets', { code: `C-${session.userId}`, outer_row: '2', outer_col: '3' }, 'Cabinet: C2'],
		['bins', references.bins[session.userId], 'Drawer: C2 / A1–D1'], ['products', references.products[session.userId], 'Product: RES-01 · Resistor'],
		['attribute_definitions', references.attribute_definitions[session.userId], 'Specification type: Resistance'],
		['product_attributes', { product_id: session.userId, attribute_id: session.userId }, 'Product specification: RES-01 · Resistor · Resistance'],
		['purchase_orders', references.purchase_orders[session.userId], 'Order: Supplier · REF-01'],
		['purchase_order_lines', { product_id: session.userId, order_id: session.userId }, 'Order line: RES-01 · Resistor · Supplier · REF-01'],
		['count_batches', { title: 'Friday count' }, 'Stock count: Friday count'], ['checkout_contacts', {}, 'Buyer contact detail']
	];
	for (const [table, data, expected] of cases) expect(describeAudit(audit(table, data, null), 'en', references).subject).toBe(expected);
	expect(describeAudit(audit('cabinets', { outer_row: '2', outer_col: '3' }, { outer_row: null, outer_col: null, is_archived: true }), 'en').subject).toBe('Cabinet: C2');
});

test('audit reference reads use staff credentials and load cabinet names for referenced drawers', async () => {
	const rows: Record<string, Record<string, unknown>[]> = {
		amp_staff_members: [{ id: session.userId, display_name: 'Ada' }],
		amp_bins: [{ id: session.userId, ...references.bins[session.userId] }],
		amp_cabinets: [{ id: session.userId, ...references.cabinets[session.userId] }]
	};
	const loaded = await readAuditReferences(session, [audit('products', { bin_id: null }, { bin_id: session.userId })], async (input, init) => {
		const url = new URL(String(input));
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer staff-jwt');
		expect(url.searchParams.get('id')).toBe(`in.(${session.userId})`);
		return new Response(JSON.stringify(url.searchParams.has('and') ? [] : rows[url.pathname.split('/').at(-1)!]));
	});
	expect(loaded.cabinets[session.userId].outer_col).toBe('3');
	expect(describeAudit(audit('products', { bin_id: null }, { bin_id: session.userId }), 'en', loaded).fields).toEqual([{ label: 'Drawer', before: 'Not set', after: 'C2 / A1–D1' }]);
});

test('an archived drawer resolves to its former place instead of hiding the placement change', async () => {
	const archived = '00000000-0000-4000-8000-0000000000a1'; const cabinet = '00000000-0000-4000-8000-0000000000c1';
	const rows: Record<string, Record<string, unknown>[]> = {
		amp_bins: [{ id: archived, label: null, inner_row: null, inner_col: null, row_span: null, col_span: null, cabinet_id: null }],
		amp_archived_bin_locations: [{ bin_id: archived, cabinet_id: cabinet, cabinet_label: null, cabinet_outer_row: 2, cabinet_outer_col: 3, inner_row: 1, inner_col: 1, row_span: 1, col_span: 1 }],
		// The cabinet has moved to D2 since; the archived drawer still reads as C2.
		amp_cabinets: [{ id: cabinet, label: null, outer_row: 2, outer_col: 4 }]
	};
	const entry = audit('products', { bin_id: archived }, { bin_id: null });
	const moved = audit('cabinets', { cabinet_id: null }, { cabinet_id: cabinet });
	const loaded = await readAuditReferences(session, [entry, moved], async input => {
		const url = new URL(String(input));
		return new Response(JSON.stringify(url.searchParams.has('and') ? [] : rows[url.pathname.split('/').at(-1)!] ?? []));
	});
	expect(describeAudit(entry, 'en', loaded).fields).toEqual([{ label: 'Drawer', before: 'C2 / A1', after: 'Not set' }]);
	expect(loaded.cabinets[cabinet].outer_col).toBe('4');
});
