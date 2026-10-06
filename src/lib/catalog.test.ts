import { describe, expect, test } from 'bun:test';
import { ApiError, parseApiJson } from './api';
import {
	CatalogResponseError,
	lookupCatalogProduct,
	parseCatalogProducts,
	readCatalogPage,
	readCatalogFacets,
	readCompleteCatalog,
	type CatalogConfig
} from './catalog';
import { CatalogQueryError, parseCatalogQuery } from './catalog-search';
import { catalogSort } from './product-specifications';
import { productCodeFromEntry } from './scanner/payload';

const config: CatalogConfig = { url: 'https://catalog.example.invalid', publishableKey: 'sb_publishable_test' };

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
		last_counted_at: '2026-09-19T12:34:56.123456+00:00',
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
			resistance: { label: 'Resistance', unit: 'ohm', value_type: 'number', value: '1000' },
			capacitance: { label: 'Capacitance', unit: 'F', value_type: 'number', value: '0.000000000005' },
			large_value: { label: 'Exact value', unit: null, value_type: 'number', value: '9007199254740993.000000000001' },
			package: { label: 'Package', unit: null, value_type: 'text', value: '0603' },
			polarized: { label: 'Polarized', unit: null, value_type: 'boolean', value: false }
		}
	};
}

function decode(rows: unknown) {
	return parseCatalogProducts(parseApiJson(JSON.stringify(rows)));
}

function responding(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status });
}

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
		expect(product.inner_row).toBe(4);
		expect(product.description).toBeNull();
		expect(product.bin_label).toBeNull();
		expect(product.last_counted_at).toBe('2026-09-19T12:34:56.123456+00:00');
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

	test('follows numeric value precision rather than rejecting harmless trailing zeros', () => {
		const [product] = decode([{ ...fixture(), sale_step: '0.1000000', quantity: '1.0000000', sale_unit_price_nok: '999999999999.0000000' }]);
		expect(product.sale_step).toBe('0.1000000');
		expect(product.sale_unit_price_nok).toBe('999999999999.0000000');
	});

	test('rejects missing fields, incorrect scalar types, unsafe URLs and impossible placement', () => {
		for (const changes of [
			{ quantity: undefined }, { attributes: null }, { description: true },
			{ name_nb: undefined }, { name_en: '' },
			{ sale_step: '0' }, { sale_step: '0.0000001' }, { sale_unit_price_nok: '-0.001' },
			{ sale_unit_price_nok: '999999999999.000001' }, { quantity: '0.0000001' },
			{ quantity: 'NaN' }, { quantity: 'Infinity' }, { product_id: 'not-a-uuid' },
			{ code: 'res-a3f09' }, { unit_code: 'PCS' },
			{ inner_row: null }, { inner_row: 0 }, { row_span: 10 },
			{ bin_code: null }, { location_note: 'Filamenthylla' }, { location_note: undefined },
			{ outer_row: '9007199254740993' }, { inner_cols: 2 },
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
			{ label: 'Flag', unit: null, value_type: 'boolean', value: 'false' },
			{ label: 'Value', unit: null, value_type: 'number', value: false },
			{ label: 'Value', unit: null, value_type: 'number', value: 'Infinity' },
			{ label: 'Value', unit: 'V', value_type: 'text', value: '3.3' },
			{ label: 'Value', value_type: 'number', value: '1' },
			{ label: 'Value', unit: null, value_type: 'list', value: [] }
		]) {
			expect(() => decode([{ ...fixture(), attributes: { value: attribute } }])).toThrow(CatalogResponseError);
		}
	});
});

describe('catalog HTTP reads and completeness', () => {
	test('manual compact codes resolve through exact validated lookups, preserving legacy identities', async () => {
		for (const [input, canonical] of [['res00026', 'RES-00026'], [' RES00026 ', 'RES-00026'],
			['res-00026', 'RES-00026'], ['resa3f09', 'RES-A3F09'], ['amp00123', 'AMP-00123']]) {
			const code = productCodeFromEntry(input)!;
			const requested: string[] = [];
			const result = await lookupCatalogProduct(config, code, { allowCompactCode: true, fetcher: async (_, init) => {
				const { p_code } = JSON.parse(String(init?.body)); requested.push(p_code);
				return Response.json(p_code === canonical ? [fixture(canonical)] : []);
			} });
			expect(result?.code).toBe(canonical);
			expect(requested).toEqual(code === canonical ? [code] : [code, canonical]);
		}
		let requests = 0;
		const exact = await lookupCatalogProduct(config, 'RES00026', { allowCompactCode: true, fetcher: async () => {
			requests++; return Response.json([fixture('RES00026')]);
		} });
		expect(exact?.code).toBe('RES00026');
		expect(requests).toBe(1);
	});

	test('compact fallback is opt-in, bounded, and never hides failed or mismatched reads', async () => {
		for (const [code, allowCompactCode, expectedCalls] of [
			['RES00026', false, 1], ['RES00026', true, 2], ['A', true, 1], ['LM358', true, 1], ['RES26', true, 1]
		] as const) {
			let calls = 0;
			expect(await lookupCatalogProduct(config, code, { allowCompactCode, fetcher: async () => {
				calls++; return Response.json([]);
			} })).toBeNull();
			expect(calls).toBe(expectedCalls);
		}
		for (const body of [{ message: 'Unavailable' }, [fixture('RES-00026')]]) {
			let calls = 0;
			await expect(lookupCatalogProduct(config, 'RES00026', { allowCompactCode: true, fetcher: async () => {
				calls++; return Response.json(body, { status: Array.isArray(body) ? 200 : 503 });
			} })).rejects.toBeInstanceOf(Array.isArray(body) ? CatalogResponseError : ApiError);
			expect(calls).toBe(1);
		}
		await expect(lookupCatalogProduct(config, 'RES00026', { allowCompactCode: true, fetcher: async (_, init) =>
			Response.json(JSON.parse(String(init?.body)).p_code === 'RES00026' ? [] : [fixture('RES-00027')])
		})).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('direct lookup sends only its code with the public key and supports cancellation', async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | null | undefined;
		const result = await lookupCatalogProduct(config, 'RES-A3F09', {
			signal: controller.signal,
			fetcher: async (input, init) => {
				expect(String(input)).toBe('https://catalog.example.invalid/rest/v1/rpc/amp_catalog');
				expect(init?.body).toBe('{"p_code":"RES-A3F09"}');
				expect(init?.method).toBe('POST');
				requestSignal = init?.signal;
				expect(requestSignal?.aborted).toBe(false);
				expect(init?.credentials).toBe('omit');
				expect(init?.cache).toBe('no-store');
				expect(init?.redirect).toBe('manual');
				const headers = new Headers(init?.headers);
				expect(headers.get('apikey')).toBe(config.publishableKey);
				expect(headers.has('Authorization')).toBe(false);
				return new Response(JSON.stringify([fixture()]));
			}
		});
		expect(result?.code).toBe('RES-A3F09');
		controller.abort();
		expect(requestSignal?.aborted).toBe(true);
	});

	test('search and scoped drawer reads stay paginated and map typed filter errors', async () => {
		const query = parseCatalogQuery(new URLSearchParams('q=1+kΩ&category=Resistors&min.resistance=1000&after=RES-A0001&cabinet=00000000-0000-4000-8000-000000000002&bin=00000000-0000-4000-8000-000000000003'));
		await readCatalogPage(config, { query, limit: 50, binId: '00000000-0000-4000-8000-000000000001', fetcher: async (_, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({ p_q: '1 kΩ', p_categories: ['Resistors'], p_conditions: { resistance: { min: '1000' } },
				p_after_code: 'RES-A0001', p_limit: 50, p_bin_id: '00000000-0000-4000-8000-000000000001',
				p_cabinet_ids: ['00000000-0000-4000-8000-000000000002'], p_bin_ids: ['00000000-0000-4000-8000-000000000003'] });
			expect(body.p_labels.units.ohm).toContainEqual({ symbol: 'kΩ', exponent: 3 });
			return new Response('[]');
		} });
		await expect(readCatalogPage(config, { query, fetcher: responding({ message: 'UNKNOWN_CATALOG_ATTRIBUTE' }, 400) })).rejects.toEqual(new CatalogQueryError('unknownAttribute'));
	});

	test('facet reads preserve exact sorted values and reject malformed or duplicate choices', async () => {
		const facet = { code: 'capacitance', definition: decode([fixture()])[0].attributes.capacitance,
			values: ['0.000000000005', '9007199254740993.000000000001'] };
		const raw = { categories: ['Capacitors'], attributes: [facet] };
		expect(await readCatalogFacets(config, { categories: ['Capacitors'], fetcher: async (url, init) => {
			expect(String(url)).toEndWith('/rpc/amp_catalog_facets');
			expect(init?.body).toBe('{"p_categories":["Capacitors"]}');
			return new Response(JSON.stringify(raw));
		} })).toEqual(raw);
		for (const invalid of [
			{ ...raw, categories: ['Capacitors', 'Capacitors'] }, { ...raw, attributes: [facet, facet] },
			{ ...raw, attributes: [{ ...facet, values: [...facet.values].reverse() }] },
			{ ...raw, attributes: [{ ...facet, values: ['0.000000000005', '0.000000000005000'] }] }
		]) await expect(readCatalogFacets(config, { fetcher: responding(invalid) })).rejects.toBeInstanceOf(CatalogResponseError);
	});

	test('valid missing product is null; failed or mismatched reads are unavailable errors', async () => {
		expect(await lookupCatalogProduct(config, 'RES-A3F09', { fetcher: responding([]) })).toBeNull();
		await expect(lookupCatalogProduct(config, 'RES-A3F09', { fetcher: responding({ message: 'Unavailable' }, 503) })).rejects.toBeInstanceOf(ApiError);
		await expect(lookupCatalogProduct(config, 'RES-A3F09', { fetcher: responding([fixture('CAP-A3F09')]) })).rejects.toBeInstanceOf(CatalogResponseError);
		await expect(lookupCatalogProduct(config, 'RES-A3F09', { fetcher: responding([fixture(), fixture('CAP-A3F09', 2)]) })).rejects.toBeInstanceOf(CatalogResponseError);
		await expect(lookupCatalogProduct(config, 'RES-A3F09', { fetcher: async () => new Response('{') })).rejects.toThrow();
	});

	test('short pages remain incomplete and traversal requests the final empty page', async () => {
		const short = await readCatalogPage(config, { limit: 200, fetcher: responding([fixture()]) });
		expect(short.complete).toBe(false);
		expect(short.nextAfterCode).toBe('RES-A3F09');
		const seen: unknown[] = [];
		const pages = [[fixture('RES-00001', 1)], [fixture('RES-00002', 2)], []];
		const products = await readCompleteCatalog(config, { limit: 200, fetcher: async (_input, init) => {
			seen.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify(pages[seen.length - 1]));
		} });
		expect(products.map((product) => product.code)).toEqual(['RES-00001', 'RES-00002']);
		expect(seen).toEqual([
			{ p_after_code: null, p_limit: 200, p_sort: catalogSort },
			{ p_after_code: 'RES-00001', p_limit: 200, p_sort: catalogSort },
			{ p_after_code: 'RES-00002', p_limit: 200, p_sort: catalogSort }
		]);
		expect(catalogSort.slice(0, 2)).toEqual([['Resistors', 'resistance'], ['Capacitors', 'capacitance']]);
		expect(catalogSort.at(-1)).toEqual(['Miscellaneous', null]);
	});

	test('rejects repeated cursors, cycles and duplicate identities rather than completing', async () => {
		await expect(readCatalogPage(config, { afterCode: 'RES-A3F09', fetcher: responding([fixture()]) })).rejects.toBeInstanceOf(CatalogResponseError);
		for (const pages of [
			[[fixture()], [fixture()]],
			[[fixture('RES-00001', 1)], [fixture('RES-00002', 2)], [fixture('RES-00001', 1)]],
			[[fixture('RES-00001', 1)], [fixture('RES-00002', 1)]]
		]) {
			let index = 0;
			await expect(readCompleteCatalog(config, { fetcher: async () => new Response(JSON.stringify(pages[index++])) })).rejects.toBeInstanceOf(CatalogResponseError);
		}
	});

	test('retains SQL ordering without imposing JavaScript punctuation collation', async () => {
		const rows = [fixture('A1', 1), fixture('A-2', 2)];
		const page = await readCatalogPage(config, { fetcher: responding(rows) });
		expect(page.products.map((product) => product.code)).toEqual(['A1', 'A-2']);
	});

	test('a failed later page never returns partial success', async () => {
		let count = 0;
		await expect(readCompleteCatalog(config, { fetcher: async () => {
			count++;
			return count === 1 ? new Response(JSON.stringify([fixture()])) : new Response('{}', { status: 503 });
		} })).rejects.toBeInstanceOf(ApiError);
		expect(count).toBe(2);
	});

	test('aborts between pages before making another request', async () => {
		const controller = new AbortController();
		let count = 0;
		await expect(readCompleteCatalog(config, { signal: controller.signal, fetcher: async () => {
			count++;
			controller.abort();
			return new Response(JSON.stringify([fixture()]));
		} })).rejects.toThrow();
		expect(count).toBe(1);
	});

	test('validates request bounds and configuration before sending a request', async () => {
		let called = false;
		const fetcher = async () => { called = true; return new Response('[]'); };
		for (const limit of [0, 201, 1.5, NaN]) {
			await expect(readCatalogPage(config, { limit, fetcher })).rejects.toBeInstanceOf(TypeError);
		}
		await expect(lookupCatalogProduct(config, '../admin', { fetcher })).rejects.toBeInstanceOf(TypeError);
		await expect(readCatalogPage({ ...config, url: 'https://example.invalid/?secret=bad' }, { fetcher })).rejects.toBeInstanceOf(TypeError);
		await expect(readCatalogPage({ ...config, publishableKey: 'sb_secret_never_public' }, { fetcher })).rejects.toBeInstanceOf(TypeError);
		expect(called).toBe(false);
	});
});
