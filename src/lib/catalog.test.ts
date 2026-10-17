import { describe, expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import {
	CatalogResponseError,
	forSale,
	lookupCatalogProduct,
	parseCatalogProducts,
	productVariants,
	readCatalogPage,
	readCatalogFacets,
	readCompleteCatalog
} from './catalog';
import { CatalogQueryError, parseCatalogQuery } from './catalog-search';
import { rejection, type ConvexCaller } from './convex';
import { productCodeFromEntry } from './scanner/payload';

type Args = Record<string, unknown>;
/** A stub client answering public catalog queries by function name, recording each call. */
function stub(answer: (name: string, args: Args) => unknown) {
	const calls: { name: string; args: Args }[] = [];
	const unexpected = async () => { throw new Error('Unexpected write'); };
	const client = {
		query: async (fn: FunctionReference<'query'>, args: Args) => {
			const name = getFunctionName(fn);
			calls.push({ name, args });
			return answer(name, args);
		},
		mutation: unexpected, action: unexpected
	} as unknown as ConvexCaller;
	return { client, calls };
}
/** Pages answered in turn, each `complete` only when it is the last. */
function pages(...rows: unknown[][]) {
	let index = 0;
	return stub(() => {
		const products = rows[index++] as { code: string }[];
		return { products, complete: index >= rows.length, nextAfterCode: products.at(-1)?.code ?? null };
	});
}

function fixture(code = 'RES-A3F09', id = 1): Record<string, unknown> {
	return {
		product_id: `00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`,
		code,
		name_nb: 'Motstand 1 kΩ',
		name_en: 'Resistor 1 kΩ',
		description: null,
		category_name: 'Resistors',
		unit_code: 'pcs',
		unit_symbol: 'stk',
		sale_step: '1',
		sale_unit_price_nok: '0.005',
		quantity: '-9007199254740993.000001',
		last_counted_at: '2026-09-19T12:34:56.123Z',
		cabinet_code: 'internal-cabinet-1',
		outer_row: 2,
		outer_col: 3,
		inner_rows: 12,
		inner_cols: 4,
		bin_code: 'internal-bin-1',
		bin_label: null,
		inner_row: 4,
		inner_col: 2,
		row_span: 1,
		col_span: 2,
		location_note: null,
		datasheet_url: 'https://example.invalid/datasheet.pdf',
		attributes: {
			resistance: { label: 'Resistance', unit: 'ohm', value_type: 'number', value: '1000', max: null },
			capacitance: { label: 'Capacitance', unit: 'F', value_type: 'number', value: '0.000000000005', max: null },
			large_value: { label: 'Exact value', unit: null, value_type: 'number', value: '9007199254740993.000000000001', max: null },
			// The backend sends no upper bound for text and booleans.
			package: { label: 'Package', unit: null, value_type: 'text', value: '0603' },
			polarized: { label: 'Polarized', unit: null, value_type: 'boolean', value: false }
		},
		distinguishing: ['package', 'tolerance']
	};
}

function decode(rows: unknown) {
	return parseCatalogProducts(structuredClone(rows));
}

describe('look-alike products', () => {
	const attributes = {
		voltage: { label: 'Voltage', unit: 'V', value_type: 'number', value: '350', max: null },
		tolerance: { label: 'Tolerance', unit: '%', value_type: 'number', value: '5', max: null },
		package: { label: 'Package', unit: null, value_type: 'text', value: 'TO-220', max: null },
		blank: { label: 'Blank', unit: null, value_type: 'text', value: '', max: null },
		polarised: { label: 'Polarised', unit: null, value_type: 'boolean', value: true, max: null },
		pins: { label: 'Pins', unit: null, value_type: 'number', value: '8', max: null },
		pitch: { label: 'Pitch', unit: 'mm', value_type: 'number', value: '2.54', max: null }
	} as const;
	test('a value with a unit names itself; others keep their translated field name', () => {
		expect(productVariants({ attributes, distinguishing: ['voltage'] }, 'nb')).toEqual(['350 V']);
		expect(productVariants({ attributes, distinguishing: ['voltage', 'tolerance'] }, 'en')).toEqual(['350 V', '5 %']);
		expect(productVariants({ attributes, distinguishing: ['package'] }, 'nb')).toEqual(['Kapsling: TO-220']);
		expect(productVariants({ attributes, distinguishing: ['polarised'] }, 'en')).toEqual(['Polarised: Yes']);
		expect(productVariants({ attributes, distinguishing: ['pins', 'pitch'] }, 'nb')).toEqual(['Antall pinner: 8', '2,54 mm']);
	});
	test('nothing is shown for values this product lacks or a product without look-alikes', () => {
		expect(productVariants({ attributes, distinguishing: [] }, 'nb')).toEqual([]);
		expect(productVariants({ attributes, distinguishing: ['blank', 'colour'] }, 'nb')).toEqual([]);
		expect(productVariants({ attributes, distinguishing: ['colour', 'voltage'] }, 'nb')).toEqual(['350 V']);
	});
});

describe('catalog response boundary', () => {
	test('preserves all domain decimals and converts only bounded structural coordinates', () => {
		const [product] = decode([fixture()]);
		expect(product.sale_unit_price_nok).toBe('0.005');
		expect(product.quantity).toBe('-9007199254740993.000001');
		expect(product.attributes.capacitance.value).toBe('0.000000000005');
		expect(product.attributes.large_value.value).toBe('9007199254740993.000000000001');
		expect(product.attributes.package.value).toBe('0603');
		expect(product.attributes.polarized.value).toBe(false);
		expect(Object.hasOwn(product.attributes, 'tolerance')).toBe(false);
		// A distinguishing code may name a value this product lacks.
		expect(product.distinguishing).toEqual(['package', 'tolerance']);
		expect(product.inner_row).toBe(4);
		expect(product.description).toBeNull();
		expect(product.bin_label).toBeNull();
		expect(product.last_counted_at).toBe('2026-09-19T12:34:56.123Z');
	});

	test('allows known zero, never-counted, missing optional details and empty attributes', () => {
		const [product] = decode([{ ...fixture(), quantity: '0', sale_unit_price_nok: '0',
			category_name: null, datasheet_url: null, last_counted_at: null, attributes: {} }]);
		expect(product.quantity).toBe('0');
		expect(product.attributes).toEqual({});
		expect(product.last_counted_at).toBeNull();
	});

	test('accepts a product stored outside the drawer wall, with or without a note', () => {
		const offShelf = { cabinet_code: null, outer_row: null, outer_col: null, inner_rows: null, inner_cols: null,
			bin_code: null, bin_label: null, inner_row: null, inner_col: null, row_span: null, col_span: null };
		const [noted, unnoted] = decode([{ ...fixture(), ...offShelf, location_note: 'Filamenthylla' },
			{ ...fixture(), ...offShelf, product_id: '00000000-0000-4000-8000-000000000009', code: 'MIS-A0001', location_note: null }]);
		expect(noted.bin_code).toBeNull();
		expect(noted.location_note).toBe('Filamenthylla');
		expect(unnoted.location_note).toBeNull();
		expect(() => decode([{ ...fixture(), ...offShelf, inner_row: 1 }])).toThrow(CatalogResponseError);
	});

	test('a borrow-only product has no price and is not for sale', () => {
		const [product] = decode([{ ...fixture(), sale_unit_price_nok: null }]);
		expect(product.sale_unit_price_nok).toBeNull();
		expect(forSale(product)).toBe(false);
		expect(forSale(decode([fixture()])[0])).toBe(true);
	});

	test('follows numeric value precision rather than rejecting harmless trailing zeros', () => {
		const [product] = decode([{ ...fixture(), sale_step: '0.1000000', quantity: '1.0000000', sale_unit_price_nok: '999999999999.0000000' }]);
		expect(product.sale_step).toBe('0.1000000');
		expect(product.sale_unit_price_nok).toBe('999999999999.0000000');
	});

	test('rejects missing fields, incorrect scalar types, unsafe URLs and impossible placement', () => {
		for (const changes of [
			{ quantity: undefined }, { attributes: null }, { description: true },
			{ distinguishing: undefined }, { distinguishing: null }, { distinguishing: ['Voltage'] },
			{ distinguishing: ['voltage', 'voltage'] }, { distinguishing: [1] },
			{ name_nb: undefined }, { name_en: '' },
			{ sale_step: '0' }, { sale_step: '0.0000001' }, { sale_unit_price_nok: '-0.001' },
			{ sale_unit_price_nok: '999999999999.000001' }, { quantity: '0.0000001' },
			{ quantity: 'NaN' }, { quantity: 'Infinity' }, { product_id: 'not-a-uuid' },
			{ code: 'res-a3f09' }, { unit_code: 'PCS' },
			{ inner_row: null }, { inner_row: 0 }, { row_span: 10 },
			{ bin_code: null }, { location_note: 'Filamenthylla' }, { location_note: undefined },
			{ outer_row: '2' }, { outer_row: 2147483648 }, { inner_row: 1.5 }, { inner_cols: 2 },
			{ last_counted_at: 'not-a-timestamp' },
			{ datasheet_url: 'javascript:alert(1)' },
			{ datasheet_url: 'https://user:password@example.invalid/file' }
		]) {
			expect(() => decode([{ ...fixture(), ...changes }])).toThrow(CatalogResponseError);
		}
		for (const rows of [null, {}, [null], [fixture(), fixture()]]) {
			expect(() => decode(rows)).toThrow(CatalogResponseError);
		}
	});

	test('requires each attribute type and unit to agree without treating missing as false', () => {
		for (const attribute of [
			{ label: 'Flag', unit: null, value_type: 'boolean', value: 'false', max: null },
			{ label: 'Value', unit: null, value_type: 'number', value: false, max: null },
			{ label: 'Value', unit: null, value_type: 'number', value: 'Infinity', max: null },
			{ label: 'Value', unit: 'V', value_type: 'text', value: '3.3', max: null },
			{ label: 'Value', value_type: 'number', value: '1', max: null },
			{ label: 'Value', unit: null, value_type: 'list', value: [] },
			// A range's upper bound is exact and above the lower; only numbers have one.
			{ label: 'Value', unit: 'V', value_type: 'number', value: '250' },
			{ label: 'Value', unit: 'V', value_type: 'number', value: '250', max: '250' },
			{ label: 'Value', unit: 'V', value_type: 'number', value: '250', max: '1e3' },
			{ label: 'Value', unit: null, value_type: 'text', value: 'TO-220', max: '5' },
			{ label: 'Flag', unit: null, value_type: 'boolean', value: true, max: '1' }
		]) {
			expect(() => decode([{ ...fixture(), attributes: { value: attribute } }])).toThrow(CatalogResponseError);
		}
	});

	test('text and booleans may carry a null upper bound but never a value', () => {
		const [product] = decode([{ ...fixture(), attributes: { package: { label: 'Package', unit: null, value_type: 'text', value: '0603', max: null } } }]);
		expect(product.attributes.package).toEqual({ label: 'Package', unit: null, value_type: 'text', value: '0603' });
	});

	test('a range keeps both exact bounds', () => {
		const [product] = decode([{ ...fixture(), attributes: { voltage: { label: 'Voltage', unit: 'V', value_type: 'number', value: '250', max: '400.000' } } }]);
		expect(product.attributes.voltage).toEqual({ label: 'Voltage', unit: 'V', value_type: 'number', value: '250', max: '400.000' });
		expect(productVariants({ ...product, distinguishing: ['voltage'] }, 'nb')).toEqual(['250–400 V']);
	});
});

describe('catalog reads and completeness', () => {
	test('manual compact codes resolve through exact validated lookups, preserving legacy identities', async () => {
		for (const [input, canonical] of [['res00026', 'RES-00026'], [' RES00026 ', 'RES-00026'],
			['res-00026', 'RES-00026'], ['resa3f09', 'RES-A3F09'], ['amp00123', 'AMP-00123']]) {
			const code = productCodeFromEntry(input)!;
			const { client, calls } = stub((_, args) => args.code === canonical ? fixture(canonical) : null);
			const result = await lookupCatalogProduct(client, code, { allowCompactCode: true });
			expect(result?.code).toBe(canonical);
			expect(calls.map((call) => call.args.code)).toEqual(code === canonical ? [code] : [code, canonical]);
		}
		const { client, calls } = stub(() => fixture('RES00026'));
		expect((await lookupCatalogProduct(client, 'RES00026', { allowCompactCode: true }))?.code).toBe('RES00026');
		expect(calls).toEqual([{ name: 'catalog:product', args: { code: 'RES00026' } }]);
	});

	test('compact fallback is opt-in, bounded, and never hides failed or mismatched reads', async () => {
		for (const [code, allowCompactCode, expectedCalls] of [
			['RES00026', false, 1], ['RES00026', true, 2], ['A', true, 1], ['LM358', true, 1], ['RES26', true, 1]
		] as const) {
			const { client, calls } = stub(() => null);
			expect(await lookupCatalogProduct(client, code, { allowCompactCode })).toBeNull();
			expect(calls).toHaveLength(expectedCalls);
		}
		const outage = stub(() => { throw new Error('Network'); });
		await expect(lookupCatalogProduct(outage.client, 'RES00026', { allowCompactCode: true })).rejects.toThrow('Network');
		expect(outage.calls).toHaveLength(1);
		const mismatch = stub(() => fixture('RES-00026'));
		await expect(lookupCatalogProduct(mismatch.client, 'RES00026', { allowCompactCode: true })).rejects.toBeInstanceOf(CatalogResponseError);
		expect(mismatch.calls).toHaveLength(1);
		const wrongFallback = stub((_, args) => args.code === 'RES00026' ? null : fixture('RES-00027'));
		await expect(lookupCatalogProduct(wrongFallback.client, 'RES00026', { allowCompactCode: true })).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('cancelling a lookup rejects at once, and a cancelled one never calls', async () => {
		const controller = new AbortController();
		const pending = stub(() => new Promise(() => {}));
		const lookup = lookupCatalogProduct(pending.client, 'RES-A3F09', { signal: controller.signal });
		controller.abort();
		await expect(lookup).rejects.toThrow();
		const { client, calls } = stub(() => fixture());
		await expect(lookupCatalogProduct(client, 'RES-A3F09', { signal: controller.signal })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	test('search and scoped drawer reads send the parsed query and map rejected filters', async () => {
		const query = parseCatalogQuery(new URLSearchParams('q=1+kΩ&category=Resistors&min.resistance=1000&after=RES-A0001&cabinet=00000000-0000-4000-8000-000000000002&bin=00000000-0000-4000-8000-000000000003'));
		const { client, calls } = stub(() => ({ products: [], complete: true, nextAfterCode: null }));
		expect(await readCatalogPage(client, { query, limit: 50, binId: '00000000-0000-4000-8000-000000000001' }))
			.toEqual({ products: [], complete: true, nextAfterCode: null });
		expect(calls).toEqual([{ name: 'catalog:page', args: { q: '1 kΩ', categories: ['Resistors'], conditions: { resistance: { min: '1000' } },
			afterCode: 'RES-A0001', limit: 50, binId: '00000000-0000-4000-8000-000000000001',
			cabinetIds: ['00000000-0000-4000-8000-000000000002'], binIds: ['00000000-0000-4000-8000-000000000003'] } }]);
		for (const [code, issue] of [['UNKNOWN_CATALOG_ATTRIBUTE', 'unknownAttribute'], ['UNKNOWN_CATALOG_CATEGORY', 'unknownCategory'],
			['INVALID_CATALOG_FILTER', 'invalidFilter'], ['INVALID_CATALOG_QUERY', 'invalidQuery'], ['CATALOG_CURSOR_MISSING', 'missingCursor']] as const) {
			await expect(readCatalogPage(stub(() => { throw rejection(code); }).client, { query })).rejects.toEqual(new CatalogQueryError(issue));
		}
		// Other rejections and outages stay unavailable rather than becoming a query problem.
		for (const error of [rejection('INVALID_CATALOG_PAGE_SIZE'), new Error('Server error')]) {
			const failure = await readCatalogPage(stub(() => { throw error; }).client, { query }).catch((cause: unknown) => cause);
			expect(failure).toBe(error);
		}
	});

	test('facet reads preserve exact sorted values and reject malformed or duplicate choices', async () => {
		const facet = { code: 'capacitance', definition: decode([fixture()])[0].attributes.capacitance,
			values: ['0.000000000005', '9007199254740993.000000000001'] };
		const raw = { categories: ['Capacitors'], attributes: [facet] };
		const { client, calls } = stub(() => structuredClone(raw));
		expect(await readCatalogFacets(client, { categories: ['Capacitors'] })).toEqual(raw);
		expect(calls).toEqual([{ name: 'catalog:facets', args: { categories: ['Capacitors'] } }]);
		for (const invalid of [
			{ ...raw, categories: ['Capacitors', 'Capacitors'] }, { ...raw, attributes: [facet, facet] },
			{ ...raw, attributes: [{ ...facet, values: [...facet.values].reverse() }] },
			{ ...raw, attributes: [{ ...facet, values: ['0.000000000005', '0.000000000005000'] }] }
		]) await expect(readCatalogFacets(stub(() => invalid).client)).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('a missing product is null; failed or mismatched reads are errors', async () => {
		expect(await lookupCatalogProduct(stub(() => null).client, 'RES-A3F09')).toBeNull();
		await expect(lookupCatalogProduct(stub(() => { throw new Error('Unavailable'); }).client, 'RES-A3F09')).rejects.toThrow('Unavailable');
		await expect(lookupCatalogProduct(stub(() => fixture('CAP-A3F09')).client, 'RES-A3F09')).rejects.toBeInstanceOf(CatalogResponseError);
		await expect(lookupCatalogProduct(stub(() => [fixture()]).client, 'RES-A3F09')).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('the server says when a page is the last; traversal follows its cursor', async () => {
		const short = await readCatalogPage(stub(() => ({ products: [fixture()], complete: true, nextAfterCode: 'RES-A3F09' })).client, { limit: 200 });
		expect(short.complete).toBe(true);
		expect(short.nextAfterCode).toBe('RES-A3F09');
		const { client, calls } = pages([fixture('RES-00001', 1)], [fixture('RES-00002', 2)]);
		const products = await readCompleteCatalog(client, { limit: 200 });
		expect(products.map((product) => product.code)).toEqual(['RES-00001', 'RES-00002']);
		expect(calls.map((call) => call.args)).toEqual([{ limit: 200 }, { limit: 200, afterCode: 'RES-00001' }]);
		expect(await readCompleteCatalog(pages([]).client)).toEqual([]);
	});

	test('rejects repeated cursors, cycles, duplicate identities and inconsistent page ends', async () => {
		await expect(readCatalogPage(pages([fixture()]).client, { afterCode: 'RES-A3F09' })).rejects.toBeInstanceOf(CatalogResponseError);
		for (const rows of [
			[[fixture()], [fixture()]],
			[[fixture('RES-00001', 1)], [fixture('RES-00002', 2)], [fixture('RES-00001', 1)]],
			[[fixture('RES-00001', 1)], [fixture('RES-00002', 1)]]
		]) await expect(readCompleteCatalog(pages(...rows).client)).rejects.toBeInstanceOf(CatalogResponseError);
		for (const page of [
			{ products: [], complete: false, nextAfterCode: null },
			{ products: [fixture()], complete: false, nextAfterCode: 'RES-00009' },
			{ products: [fixture()], complete: 'true', nextAfterCode: 'RES-A3F09' },
			{ products: [fixture(), fixture('RES-00002', 2)], complete: true, nextAfterCode: 'RES-00002' }
		]) await expect(readCatalogPage(stub(() => page).client, { limit: page.products.length === 2 ? 1 : 200 })).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('retains the server order without imposing JavaScript punctuation collation', async () => {
		const page = await readCatalogPage(pages([fixture('A1', 1), fixture('A-2', 2)]).client);
		expect(page.products.map((product) => product.code)).toEqual(['A1', 'A-2']);
	});

	test('a failed later page never returns partial success', async () => {
		let count = 0;
		const { client } = stub(() => {
			if (++count > 1) throw new Error('Unavailable');
			return { products: [fixture()], complete: false, nextAfterCode: 'RES-A3F09' };
		});
		await expect(readCompleteCatalog(client)).rejects.toThrow('Unavailable');
		expect(count).toBe(2);
	});

	test('aborts between pages before making another request', async () => {
		const controller = new AbortController();
		const { client, calls } = stub(() => {
			controller.abort();
			return { products: [fixture()], complete: false, nextAfterCode: 'RES-A3F09' };
		});
		await expect(readCompleteCatalog(client, { signal: controller.signal })).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test('validates request bounds before sending a request', async () => {
		const { client, calls } = pages([]);
		for (const limit of [0, 201, 1.5, NaN]) {
			await expect(readCatalogPage(client, { limit })).rejects.toBeInstanceOf(TypeError);
		}
		await expect(lookupCatalogProduct(client, '../admin')).rejects.toBeInstanceOf(TypeError);
		await expect(readCatalogPage(client, { binId: 'not-a-drawer' })).rejects.toBeInstanceOf(TypeError);
		expect(calls).toHaveLength(0);
	});
});
