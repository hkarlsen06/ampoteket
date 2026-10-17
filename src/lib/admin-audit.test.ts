import { expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import type { ConvexCaller, StaffSession } from './convex';
import { describeAudit, groupAudit, mergeAuditEntries, mergeAuditReferences, parseAuditPage, readAuditGap, readAuditPage, type AuditEntry, type AuditReferences } from './admin-audit';

/** A ConvexCaller that answers by function name. */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>): ConvexCaller {
	const call = async (fn: never, args: Record<string, unknown>) => {
		const name = getFunctionName(fn);
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { query: call, mutation: call, action: call } as unknown as ConvexCaller;
}
const session = { userId: '11111111-1111-4111-8111-111111111111' };
const staff = (client: ConvexCaller): StaffSession => ({ client, userId: session.userId });
const entry = (id: string) => ({ id, table_name: 'products', row_key: { id: session.userId }, action: 'UPDATE', before_data: { sale_unit_price_nok: '9007199254740993.123456' }, after_data: { sale_unit_price_nok: '9007199254740994.123456' }, actor_id: session.userId, database_role: 'authenticated', recorded_at: '2026-09-23T10:00:00Z' });
/** The backend's page query over IDs top..1, newest first, `size` at a time. */
function log(top: bigint, size = 7) {
	const calls: (string | undefined)[] = [];
	const client = stub({ 'auditLog:page': (args) => {
		const before = args.before as string | undefined; calls.push(before);
		const start = before === undefined ? top : BigInt(before) - 1n;
		const ids = Array.from({ length: size }, (_, index) => start - BigInt(index)).filter((id) => id > 0n);
		return { entries: ids.map((id) => entry(String(id))), references: { staff_members: { [session.userId]: { id: session.userId, display_name: 'Ada' } } }, more: ids.at(-1)! > 1n };
	} });
	return { client, calls };
}

test('a live page that skipped past the shown head fills the gap page by page without repeating shown entries', async () => {
	const newest = 9007199254740994n, { client, calls } = log(newest + 46n);
	const live = await readAuditPage(staff(client));
	expect(live.entries.map((row) => row.id).slice(0, 2)).toEqual([String(newest + 46n), String(newest + 45n)]);
	const gap = await readAuditGap(staff(client), live.entries.at(-1)!.id, String(newest));
	expect(gap.entries.map((row) => row.id)).toEqual(Array.from({ length: 39 }, (_, index) => String(newest + 39n - BigInt(index))));
	expect(calls.slice(1)).toEqual([String(newest + 40n), String(newest + 33n), String(newest + 26n), String(newest + 19n), String(newest + 12n), String(newest + 5n)]);
	expect(gap.references.staff_members[session.userId].display_name).toBe('Ada');
	const merged = mergeAuditEntries([...live.entries, ...gap.entries], live.entries);
	expect(merged).toHaveLength(46);
	expect(merged.map((row) => row.id)).toEqual(Array.from({ length: 46 }, (_, index) => String(newest + 46n - BigInt(index))));
});

test('audit pages retain exact nested values, pass the cursor and reject entries out of order', async () => {
	let before: unknown;
	const page = await readAuditPage(staff(stub({ 'auditLog:page': (args) => { before = args.before; return { entries: [entry('9007199254740993')], references: {}, more: false }; } })), '9007199254740994');
	expect(before).toBe('9007199254740994');
	expect(page.entries[0].before?.sale_unit_price_nok).toBe('9007199254740993.123456');
	expect(page.more).toBe(false);
	expect(() => parseAuditPage({ entries: [entry('5'), entry('6')], references: {}, more: false })).toThrow('cursor');
	expect(() => parseAuditPage({ entries: [entry('7')], references: {}, more: false }, '7')).toThrow('cursor');
	expect(() => parseAuditPage({ entries: [], references: { bins: { 'not-a-uuid': {} } }, more: false })).toThrow();
	expect(() => parseAuditPage({ entries: [], references: {} })).toThrow();
	await expect(readAuditPage(staff(stub({})), '01')).rejects.toThrow('Invalid audit ID');
	expect(mergeAuditReferences({ products: { a: { code: 'OLD' }, b: { code: 'KEPT' } } }, { products: { a: { code: 'NEW' } } }))
		.toEqual({ products: { a: { code: 'NEW' }, b: { code: 'KEPT' } } });
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
	// Widening a value into a range shows the new upper bound in the specification's unit.
	const range = describeAudit(audit('product_attributes', { product_id: session.userId, attribute_id: session.userId, number_value: '1000', number_max: null },
		{ product_id: session.userId, attribute_id: session.userId, number_value: '1000', number_max: '1500' }), 'nb', references);
	expect(range.fields).toEqual([{ label: 'Maks', before: 'Ikke angitt', after: '1,5 kΩ' }]);
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

test('backend references name drawers by their cabinet, whether coordinates arrive as numbers or strings', () => {
	const bin = '00000000-0000-4000-8000-0000000000b1', cabinet = '00000000-0000-4000-8000-0000000000c1';
	const loaded: AuditReferences = { bins: { [bin]: { id: bin, label: null, inner_row: 1, inner_col: 1, row_span: 1, col_span: 4, cabinet_id: cabinet } },
		cabinets: { [cabinet]: { id: cabinet, label: null, outer_row: 2, outer_col: 3 } } };
	expect(describeAudit(audit('products', { bin_id: null }, { bin_id: bin }), 'en', loaded).fields).toEqual([{ label: 'Drawer', before: 'Not set', after: 'C2 / A1–D1' }]);
	expect(describeAudit(audit('products', { bin_id: null }, { bin_id: session.userId }), 'en', references).fields).toEqual([{ label: 'Drawer', before: 'Not set', after: 'C2 / A1–D1' }]);
});

test('an archived drawer resolves to its former place instead of hiding the placement change', () => {
	const archived = '00000000-0000-4000-8000-0000000000a1'; const cabinet = '00000000-0000-4000-8000-0000000000c1';
	// As the backend resolves it: the former place, with the cabinet where it stood then (C2); the cabinet has moved to D2 since.
	const loaded: AuditReferences = {
		bins: { [archived]: { id: archived, label: null, inner_row: 1, inner_col: 1, row_span: 1, col_span: 1, cabinet_id: cabinet, archived_cabinet: { label: null, outer_row: 2, outer_col: 3 } } },
		cabinets: { [cabinet]: { id: cabinet, label: null, outer_row: 2, outer_col: 4 } }
	};
	expect(describeAudit(audit('products', { bin_id: archived }, { bin_id: null }), 'en', loaded).fields).toEqual([{ label: 'Drawer', before: 'C2 / A1', after: 'Not set' }]);
	expect(describeAudit(audit('cabinets', { cabinet_id: null }, { cabinet_id: cabinet }), 'en', loaded).fields).toEqual([{ label: 'Cabinet', before: 'Not set', after: 'D2' }]);
});

test('imported images with string numbers and new images with integer numbers describe the same change alike', () => {
	// An imported cabinet row moved by the new backend: the unchanged row reads as unchanged, the moved column as moved.
	const moved = describeAudit(audit('cabinets', { outer_row: '2', outer_col: '3', inner_rows: '12' }, { outer_row: 2, outer_col: 4, inner_rows: 12 }), 'en');
	expect(moved.fields).toEqual([{ label: 'Wall column', before: '3', after: '4' }]);
	// Decimals stay strings in both and keep their unit.
	expect(describeAudit(audit('products', { ...references.products[session.userId], minimum_stock: '1' }, { ...references.products[session.userId], minimum_stock: '2.5' }), 'en').fields)
		.toEqual([{ label: 'Minimum stock', before: '1 piece', after: '2.5 pieces' }]);
	expect(describeAudit(audit('help_contacts', { display_name: 'Ada', display_order: '1' }, { display_name: 'Ada', display_order: 2 }), 'en').fields)
		.toEqual([{ label: expect.any(String), before: '1', after: '2' }]);
});

test('a day of catalogue entry folds into one line per person and kind, each product carrying its specifications and count', () => {
	const ada = session.userId; const bo = '22222222-2222-4222-8222-222222222222';
	const first = '00000000-0000-4000-8000-0000000000a1'; const second = '00000000-0000-4000-8000-0000000000b2';
	const refs: AuditReferences = { ...references, staff_members: { [ada]: { display_name: 'Ada' }, [bo]: { display_name: 'Bo' } },
		products: { [first]: { code: 'RES-01', name_nb: 'Motstand', name_en: 'Resistor', unit_code: 'pcs' }, [second]: { code: 'RES-02', name_nb: 'Motstand 2', name_en: 'Resistor 2', unit_code: 'pcs' } } };
	let id = 100;
	const at = (table: string, key: Record<string, unknown>, before: AuditEntry['before'], after: AuditEntry['after'], recordedAt: string, actorId = ada): AuditEntry =>
		({ id: String(id++), table, key, action: before ? after ? 'UPDATE' : 'DELETE' : 'INSERT', before, after, actorId, role: 'authenticated', recordedAt });
	const product = (product: string, extra: Record<string, unknown> = {}) => ({ id: product, ...refs.products[product], is_active: true, bin_id: null, ...extra });
	const entries = [
		at('products', { id: first }, null, product(first), '2026-10-13T09:15:20Z'),
		at('product_attributes', { product_id: first, attribute_id: ada }, null, { product_id: first, attribute_id: ada, number_value: '1000' }, '2026-10-13T09:15:21Z'),
		at('count_batches', { id: bo }, null, { product_id: first, title: 'RES-01', finished_at: '2026-10-13T09:15:46Z' }, '2026-10-13T09:15:46Z'),
		at('products', { id: first }, product(first), product(first, { bin_id: ada }), '2026-10-13T09:17:19Z'),
		at('products', { id: second }, null, product(second), '2026-10-13T09:27:05Z'),
		// Bo's correction and Ada's edit an hour later are separate pieces of work.
		at('products', { id: second }, product(second), product(second, { is_active: false }), '2026-10-13T09:40:00Z', bo),
		at('products', { id: first }, product(first, { bin_id: ada }), product(first, { bin_id: ada, is_active: false }), '2026-10-13T10:30:00Z'),
		// 23:30 UTC is already the next day in Oslo.
		at('products', { id: first }, product(first, { bin_id: ada, is_active: false }), product(first, { bin_id: ada }), '2026-10-13T22:30:00Z')
	];
	const days = groupAudit(entries.toReversed(), 'en', refs);
	expect(days.map(day => day.key)).toEqual(['2026-10-14', '2026-10-13']);
	const [changedByAda, changedByBo, created] = days[1].batches;
	expect(created).toMatchObject({ action: 'INSERT', actor: 'Ada', title: '2 products', summary: 'RES-02 · Resistor 2, RES-01 · Resistor', first: '2026-10-13T09:15:20Z', last: '2026-10-13T09:27:05Z' });
	expect(created.events.map(event => event.key)).toEqual(['104', '100']);
	expect(created.events[1].fields).toEqual(expect.arrayContaining([
		{ label: 'Resistance', before: null, after: '1 kΩ' }, { label: 'Stock count', before: null, after: 'Counted' }, { label: 'Drawer', before: null, after: 'C2 / A1–D1' }
	]));
	expect(created.events[1].fields.map(field => field.label)).not.toContain('Product');
	expect(changedByBo).toMatchObject({ action: 'UPDATE', actor: 'Bo', title: 'Product: RES-02 · Resistor 2', summary: 'Publication' });
	expect(changedByAda.events[0].fields).toEqual([{ label: 'Publication', before: 'Published', after: 'Unpublished' }]);
	// A newer entry extends the day's head without renaming the events already shown.
	const later = groupAudit([at('products', { id: first }, product(first, { bin_id: ada }), product(first, { bin_id: ada, minimum_stock: '5' }), '2026-10-13T22:40:00Z'), ...entries.toReversed()], 'en', refs);
	expect(later[0].batches[0].events.map(event => event.key)).toEqual(['107']);
	expect(later[0].batches[0].events[0].fields).toEqual([{ label: 'Publication', before: 'Unpublished', after: 'Published' }, { label: 'Minimum stock', before: 'Not set', after: '5 pieces' }]);
});
