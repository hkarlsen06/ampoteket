import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { memory } from './test-storage';
import { rejection, type ConvexCaller } from './convex';
import { formatMoney } from './format';
import { matchesSearch, searchTerms } from './catalog-search';
import { adminSearchTexts, clearProductCommand, definitiveProductFailure, executeDetailCommand, executeProductCommand, generateCategoryProductCode, generateProductCode, isProductCodeCollision, parseAdminProduct, parseAttribute, parseProductWrite, persistProductCommand, ProductFieldError, productCategoryOptions, productTypes, readAdminProducts, readProductAttributes, readProductCommand, readProductStock, StaleProductError, type ProductCommand, type ProductReferences, type ProductWrite } from './admin-products';
const actor = '11111111-1111-4111-8111-111111111111'; const id = '22222222-2222-4222-8222-222222222222'; const bin = '33333333-3333-4333-8333-333333333333';
const attribute = '44444444-4444-4444-8444-444444444444';
type Handler = (args: Record<string, unknown>) => unknown;
/** A ConvexCaller that answers by function name (`products:save`) and records each call. */
function convexStub(handlers: Record<string, Handler>): ConvexCaller & { calls: string[] } {
	const calls: string[] = [];
	const call = async (fn: FunctionReference<'query' | 'mutation' | 'action'>, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push(name);
		const handler = handlers[name];
		if (!handler) throw new Error(`Unexpected call: ${name}`);
		return handler(args);
	};
	return { calls, query: call, mutation: call, action: call } as unknown as ConvexCaller & { calls: string[] };
}
const session = (client: ConvexCaller, userId = actor) => ({ client, userId });
const payload: ProductWrite = { id, code: 'RES-A3F09', name_nb: 'Motstand', name_en: 'Resistor', description: null, category_id: null, bin_id: bin, location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '999999999998.999999', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true };
const product = { ...payload, metadata_revision: '9007199254740993' };
test('unit price display pads to two decimals and preserves sub-øre precision in both languages', () => {
	for (const [stored, nb, en] of [['1.5', '1,50 kr', '1.50 NOK'], ['0.275', '0,275 kr', '0.275 NOK'], ['0', '0,00 kr', '0.00 NOK']]) {
		const price = parseProductWrite({ ...payload, sale_unit_price_nok: stored }).sale_unit_price_nok!;
		expect(formatMoney(price, 'nb')).toBe(nb);
		expect(formatMoney(price, 'en')).toBe(en);
	}
});
test('product boundary keeps exact prices and opaque revisions and enforces steps, identity and active placement', () => {
	expect(parseAdminProduct(product)).toEqual(product);
	for (const change of [{ stock_step: '0' }, { unit_code: 'pcs', sale_step: '0.5' }, { stock_step: '2', sale_step: '3' }, { sale_unit_price_nok: '0.0000001' }, { sale_unit_price_nok: 1 }, { location_note: 'Filamenthylla' }, { datasheet_url: 'javascript:alert(1)' }, { metadata_revision: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => parseAdminProduct({ ...product, ...change })).toThrow();
	expect(parseProductWrite({ ...payload, unit_code: 'm', stock_step: '0.001', sale_step: '0.1' }).sale_step).toBe('0.1');
	expect(parseProductWrite({ ...payload, bin_id: null, is_active: false }).bin_id).toBeNull();
	expect(parseProductWrite({ ...payload, minimum_stock: '25' }).minimum_stock).toBe('25');
	expect(parseProductWrite({ ...payload, sale_unit_price_nok: null }).sale_unit_price_nok).toBeNull();
	expect(generateProductCode('CAP', { getRandomValues: <T extends ArrayBufferView>(array: T) => { new Uint8Array(array.buffer).set([0xab, 0xcd, 0xef]); return array; } })).toBe('CAP-ABCDE');
});
test('an empty database offers every standard category and selection generates its code automatically', () => {
	const options = productCategoryOptions([]);
	expect(options.map(option => option.prefix)).toEqual(['RES', 'CAP', 'DIO', 'LED', 'BJT', 'MOS', 'MCU', 'SEN', 'MOT', 'DRV', 'CON', 'BRD', 'CAB', 'MIS']);
	expect(new Set(options.map(option => option.id)).size).toBe(14);
	for (const option of options) expect(generateCategoryProductCode(option.id, [])).toMatch(new RegExp(`^${option.prefix}-[0-9A-F]{5}$`));
	expect(options.find(option => option.prefix === 'MIS')?.name).toBe('Miscellaneous');
	expect(() => generateCategoryProductCode(null, [])).toThrow();
	expect(() => generateCategoryProductCode(id, [])).toThrow();
});
test('a rejected unsaved product keeps its code candidate only while it remains valid for the selected category', () => {
	const resistor = productTypes.find(type => type.prefix === 'RES')!;
	const miscellaneous = productTypes.find(type => type.prefix === 'MIS')!;
	expect(generateCategoryProductCode(resistor.id, [], 'RES-A3F09')).toBe('RES-A3F09');
	expect(generateCategoryProductCode(miscellaneous.id, [], 'RES-A3F09')).toMatch(/^MIS-[0-9A-F]{5}$/);
	for (const previousCode of ['RES-A3F0', 'RES-A3F099', 'RES-ZZZZZ', 'RES-a3f09', 'RES-A3F09-extra']) {
		const candidate = generateCategoryProductCode(resistor.id, [], previousCode);
		expect(candidate).toMatch(/^RES-[0-9A-F]{5}$/);
		expect(candidate).not.toBe(previousCode);
	}
});
test('standard categories reuse existing canonical-name identities without offering custom categories', async () => {
	const categories = [{ id: attribute, name: 'Resistors' }, { id: bin, name: 'Custom category' }];
	const option = productCategoryOptions(categories).find(option => option.prefix === 'RES')!;
	expect(option.id).toBe(attribute);
	expect(generateCategoryProductCode(option.id, categories)).toMatch(/^RES-[0-9A-F]{5}$/);
	expect(productCategoryOptions(categories).some(option => option.id === bin)).toBe(false);
	const command: ProductCommand = { userId: actor, payload: { ...payload, category_id: option.id }, revision: null };
	const saved = { ...product, category_id: option.id };
	const stub = convexStub({ 'products:save': (args) => { expect(args).toEqual({ payload: command.payload, revision: null }); return saved; } });
	expect(await executeProductCommand(session(stub), command)).toEqual(saved); expect(stub.calls).toEqual(['products:save']);
});

test('product validation identifies the rejected field without weakening exactness or placement rules', () => {
	for (const [field, value] of [['stock_step', '0'], ['sale_step', '0.5'], ['sale_unit_price_nok', '0.0000001'], ['minimum_stock', '-1'], ['minimum_stock', '1.5'], ['location_note', 'Filamenthylla'], ['datasheet_url', 'ftp://example.test/file'], ['purchase_url', 'javascript:alert(1)'], ['name_en', '']] as const) {
		try { parseProductWrite({ ...payload, [field]: value }); throw new Error('Expected field rejection'); }
		catch (error) { expect(error).toBeInstanceOf(ProductFieldError); expect((error as ProductFieldError).field).toBe(field); }
	}
});

test('an empty or missing price is rejected as the price field, never read as borrow-only', () => {
	const { sale_unit_price_nok: _, ...unpriced } = payload;
	for (const value of [{ ...payload, sale_unit_price_nok: '' }, { ...payload, sale_unit_price_nok: ' ' }, { ...payload, sale_unit_price_nok: undefined }, unpriced]) {
		try { parseProductWrite(value); throw new Error('Expected price rejection'); }
		catch (error) { expect(error).toBeInstanceOf(ProductFieldError); expect((error as ProductFieldError).field).toBe('sale_unit_price_nok'); }
	}
	expect(parseProductWrite({ ...payload, sale_unit_price_nok: '0' }).sale_unit_price_nok).toBe('0');
});

test('staff search matches unpublished products by category, specification and compact measurement', () => {
	const category = '55555555-5555-4555-8555-555555555555', pkg = '66666666-6666-4666-8666-666666666666';
	const references = { categories: [{ id: category, name: 'Resistors' }], units: [], shelf: { cabinets: [], bins: [] },
		definitions: [{ id: attribute, code: 'resistance', label: 'Resistance', value_type: 'number', canonical_unit: 'ohm' }, { id: pkg, code: 'package', label: 'Package', value_type: 'text', canonical_unit: null }] } as unknown as ProductReferences;
	const text = adminSearchTexts([{ ...product, name_nb: 'Del', name_en: 'Part', category_id: category, is_active: false }], references, [
		{ product_id: id, attribute_id: attribute, number_value: '10000', number_max: null, text_value: null, boolean_value: null },
		{ product_id: id, attribute_id: pkg, number_value: null, number_max: null, text_value: '0603', boolean_value: null }]).get(id)!;
	for (const q of ['motstand 10k 0603', '10 kΩ', 'res-a3f09', 'resa3f']) expect(matchesSearch(text, searchTerms(q))).toBe(true);
	expect(matchesSearch(text, searchTerms('capacitor'))).toBe(false);
});

test('a number range keeps exact bounds; commands saved before ranges read as single values', () => {
	const ids = { product_id: '00000000-0000-4000-8000-000000000001', attribute_id: '00000000-0000-4000-8000-000000000002' };
	expect(parseAttribute({ ...ids, number_value: '250', number_max: '400.0', text_value: null, boolean_value: null }).number_max).toBe('400');
	expect(parseAttribute({ ...ids, number_value: '250', text_value: null, boolean_value: null }).number_max).toBeNull();
	for (const invalid of [{ number_value: '250', number_max: '250' }, { number_value: '250', number_max: '100' },
		{ number_value: null, number_max: '5', text_value: 'TO-220' }, { number_value: '1', number_max: 'NaN' }]) {
		expect(() => parseAttribute({ ...ids, text_value: null, boolean_value: null, ...invalid })).toThrow();
	}
});

test('reads use the typed product functions, keep exact values and reject rows bound to another product', async () => {
	const value = { product_id: id, attribute_id: attribute, number_value: '0.000000000001', number_max: null, text_value: null, boolean_value: null };
	const stub = convexStub({
		'products:list': (args) => { expect(args).toEqual({ ids: [id] }); return [product]; },
		'products:attributes': (args) => { expect(args).toEqual({ productId: id }); return [value]; },
		'stock:inventory': (args) => { expect(args).toEqual({ productIds: [id] }); return [{ product_id: id, quantity: '2.5', revision: 7, last_counted_at: null }]; }
	});
	expect(await readAdminProducts(session(stub), [id])).toEqual([product]);
	expect((await readProductAttributes(session(stub), id))[0].number_value).toBe('0.000000000001');
	expect(await readProductStock(session(stub), id)).toEqual({ product_id: id, quantity: '2.5', revision: '7', last_counted_at: null });
	const other = convexStub({ 'products:attributes': () => [{ ...value, product_id: bin }] });
	await expect(readProductAttributes(session(other), id)).rejects.toThrow('binding');
	await expect(readAdminProducts(session(stub), ['not-a-uuid'])).rejects.toThrow();
});
test('frozen product persistence rejects replacing payload or actor and a retry after a lost reply sends the same command', async () => {
	const storage = memory(); const command: ProductCommand = { userId: actor, payload, revision: null }; persistProductCommand(storage, command); expect(readProductCommand(storage)).toEqual(command);
	expect(() => persistProductCommand(storage, { ...command, payload: { ...payload, code: 'RES-FFFFF' } })).toThrow();
	clearProductCommand(storage, { ...command, userId: bin }); expect(readProductCommand(storage)).toEqual(command);
	const sent: unknown[] = [];
	const stub = convexStub({ 'products:save': (args) => { sent.push(args); if (sent.length === 1) throw new Error('Lost response after commit'); return product; } });
	await expect(executeProductCommand(session(stub), command)).rejects.toThrow('Lost');
	expect(await executeProductCommand(session(stub), readProductCommand(storage)!)).toEqual(product);
	expect(sent[1]).toEqual(sent[0]);
	await expect(executeProductCommand(session(stub, bin), command)).rejects.toThrow('identity'); expect(sent).toHaveLength(2);
	clearProductCommand(storage, command); expect(readProductCommand(storage)).toBeNull();
});
test('an edit sends its revision and a stale rejection becomes StaleProductError without another write', async () => {
	const command: ProductCommand = { userId: actor, payload: { ...payload, name_en: 'Changed' }, revision: product.metadata_revision };
	const stub = convexStub({ 'products:save': (args) => { expect(args.revision).toBe('9007199254740993'); expect((args.payload as ProductWrite).sale_unit_price_nok).toBe('999999999998.999999'); throw rejection('STALE_PRODUCT'); } });
	await expect(executeProductCommand(session(stub), command)).rejects.toBeInstanceOf(StaleProductError);
	expect(stub.calls).toEqual(['products:save']);
	const differs = convexStub({ 'products:save': () => ({ ...product, name_en: 'Something else' }) });
	await expect(executeProductCommand(session(differs), command)).rejects.toThrow('differs');
});
test('a stale creation retry resolves to the product it created, which someone has changed since', async () => {
	const values = [{ attribute_id: attribute, number_value: null, number_max: null, text_value: 'draft', boolean_value: null }];
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes: values };
	const changed = { ...product, name_en: 'Changed by another admin' };
	const stub = convexStub({ 'products:save': () => { throw rejection('STALE_PRODUCT'); }, 'products:get': (args) => { expect(args).toEqual({ id }); return changed; } });
	expect(await executeProductCommand(session(stub), command)).toEqual(changed);
	const missing = convexStub({ 'products:save': () => { throw rejection('STALE_PRODUCT'); }, 'products:get': () => null });
	await expect(executeProductCommand(session(missing), command)).rejects.toBeInstanceOf(StaleProductError);
});
test('only a code collision permits a different code candidate, and only rejections are definite', () => {
	expect(isProductCodeCollision(rejection('PRODUCT_CODE_TAKEN'))).toBe(true);
	for (const error of [new Error('timeout'), rejection('STALE_PRODUCT'), rejection('CATEGORY_NAME_TAKEN')]) expect(isProductCodeCollision(error)).toBe(false);
	for (const code of ['INVALID_PRODUCT', 'PRODUCT_BIN_UNAVAILABLE', 'PRODUCT_CODE_TAKEN']) expect(definitiveProductFailure(rejection(code))).toBe(true);
	// A network failure or server bug leaves the outcome unknown; lost access keeps the command for a retry.
	for (const error of [new Error('timeout'), rejection('STAFF_REQUIRED')]) expect(definitiveProductFailure(error)).toBe(false);
});
test('a new product sends its frozen, validated specifications in the same command', async () => {
	const values = [{ attribute_id: attribute, number_value: '9007199254740993.000000000001', number_max: null, text_value: null, boolean_value: null }];
	const command: ProductCommand = { userId: actor, payload, revision: null, attributes: values };
	const storage = memory(); persistProductCommand(storage, command);
	expect(readProductCommand(storage)).toEqual(command);
	expect(() => persistProductCommand(storage, { ...command, attributes: [{ ...values[0], number_value: '1' }] })).toThrow('Unresolved');
	clearProductCommand(storage, { ...command, attributes: [] });
	expect(readProductCommand(storage)).toEqual(command);
	for (const change of [{ revision: '1' }, { attributes: [values[0], values[0]] }, { attributes: [{ ...values[0], boolean_value: false }] }]) {
		expect(() => persistProductCommand(memory(), { ...command, ...change })).toThrow();
	}
	const stub = convexStub({ 'products:save': (args) => { expect(args).toEqual({ payload, revision: null, attributes: values }); return product; } });
	expect(await executeProductCommand(session(stub), readProductCommand(storage)!)).toEqual(product);
});
test('a specification edit compares against the shown value and removal sends no value', async () => {
	const original = { product_id: id, attribute_id: attribute, number_value: '0.000000000001', number_max: null, text_value: null, boolean_value: null };
	expect(parseAttribute(original).number_value).toBe('0.000000000001'); expect(parseAttribute({ ...original, number_value: null, number_max: null, boolean_value: false }).boolean_value).toBe(false); expect(parseAttribute({ ...original, number_value: null, number_max: null, text_value: '' }).text_value).toBe('');
	expect(() => parseAttribute({ ...original, boolean_value: false })).toThrow(); expect(() => parseAttribute({ ...original, number_value: 'NaN' })).toThrow();
	const after = { ...original, number_value: '0.000000000002' }; const { product_id: _, ...shown } = original; const { product_id: __, ...next } = after;
	const sent: unknown[] = [];
	const stub = convexStub({ 'products:setAttribute': (args) => { sent.push(args); return 'saved'; } });
	await executeDetailCommand(session(stub), { userId: actor, kind: 'attribute', before: original, after });
	await executeDetailCommand(session(stub), { userId: actor, kind: 'attribute', before: original, after: null });
	expect(sent).toEqual([{ productId: id, before: shown, after: next }, { productId: id, before: shown, after: null }]);
	const stale = convexStub({ 'products:setAttribute': () => { throw rejection('STALE_PRODUCT'); } });
	await expect(executeDetailCommand(session(stale), { userId: actor, kind: 'attribute', before: original, after })).rejects.toBeInstanceOf(StaleProductError);
	await expect(executeDetailCommand(session(stub, bin), { userId: actor, kind: 'attribute', before: original, after })).rejects.toThrow('identity'); expect(sent).toHaveLength(2);
});
test('saved category and specification commands rename against the shown name; a legacy category creation only finishes if it applied', async () => {
	const category = { id: bin, name: 'Old' }, definition = { id: attribute, code: 'workshop_note', label: 'Note', value_type: 'text' as const, canonical_unit: null };
	const sent: [string, unknown][] = [];
	const stub = convexStub({
		'products:rename': (args) => { sent.push(['rename', args]); return 'saved'; },
		'products:createDefinition': (args) => { sent.push(['create', args]); return attribute; },
		'products:references': () => ({ categories: [category], definitions: [], units: [] })
	});
	await executeDetailCommand(session(stub), { userId: actor, kind: 'category', before: category, after: { ...category, name: 'New' } });
	await executeDetailCommand(session(stub), { userId: actor, kind: 'definition', before: definition, after: { ...definition, label: 'Workshop note' } });
	await executeDetailCommand(session(stub), { userId: actor, kind: 'definition', before: null, after: definition });
	expect(sent).toEqual([['rename', { kind: 'category', id: bin, before: 'Old', after: 'New' }], ['rename', { kind: 'definition', id: attribute, before: 'Note', after: 'Workshop note' }], ['create', definition]]);
	await executeDetailCommand(session(stub), { userId: actor, kind: 'category', before: null, after: category });
	await expect(executeDetailCommand(session(stub), { userId: actor, kind: 'category', before: null, after: { ...category, name: 'Never saved' } })).rejects.toBeInstanceOf(StaleProductError);
	expect(sent).toHaveLength(3);
});
