import { describe, expect, test } from 'bun:test';
import type { CatalogPlacement, CatalogProduct } from './catalog';
import {
	canonicalFilterNumber, catalogCategories, catalogFacets, CatalogQueryError, engineeringUnits, hasCatalogFilters, normalizeProductCode,
	parseCatalogQuery, productSearchText, sanitizeCatalogQuery, searchCatalog, serializeCatalogQuery
} from './catalog-search';

function product(index: number, changes: Partial<CatalogProduct & CatalogPlacement> = {}): CatalogProduct {
	return {
		product_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		code: `CAP-${String(index).padStart(5, '0')}`, name_nb: 'Keramisk kondensator', name_en: 'Ceramic capacitor', description: 'For filters',
		category_name: 'Capacitors', unit_code: 'pcs', unit_symbol: 'stk', sale_step: '1', sale_unit_price_nok: '0.005',
		quantity: '100', last_counted_at: null, cabinet_code: 'C1', outer_row: 1, outer_col: 1,
		inner_rows: 10, inner_cols: 10, bin_code: `B${index}`, bin_label: null, inner_row: 1, inner_col: 1,
		row_span: 1, col_span: 1, location_note: null, datasheet_url: null,
		attributes: {
			capacitance: { label: 'Capacitance', value_type: 'number', unit: 'F', value: '0.000000000005' },
			package: { label: 'Package', value_type: 'text', unit: null, value: '0603' },
			polarized: { label: 'Polarized', value_type: 'boolean', unit: null, value: false }
		}, ...changes
	};
}
const query = (search = '') => parseCatalogQuery(new URLSearchParams(search));

describe('catalog search and shareable conditions', () => {
	test('catalog and staff search find compact codes without changing name punctuation', () => {
		const part = product(26, { code: 'RES-00026', name_nb: 'Motstand SOT-23', name_en: 'Resistor SOT-23', category_name: 'Resistors' });
		for (const q of ['res00026', 'RES00026', 'res000', 'res-00026', '00026']) {
			expect(searchCatalog([part], query(`q=${q}&category=Resistors`)).products).toEqual([part]);
			expect(productSearchText(part).toLowerCase().includes(q.toLowerCase())).toBe(true);
		}
		expect(searchCatalog([part], query('q=res00026+resistor')).products).toEqual([part]);
		expect(searchCatalog([part], query('q=res00027')).products).toEqual([]);
		expect(searchCatalog([part], query('q=SOT23')).products).toEqual([]);
	});

	test('round-trips location scopes', () => {
		const cabinet = '00000000-0000-4000-8000-000000000001';
		const first = '00000000-0000-4000-8000-000000000002';
		const elsewhere = '00000000-0000-4000-8000-000000000004';
		const params = `category=Capacitors&cabinet=${cabinet}&bin=${elsewhere}&after=CAP-00001`;
		const selected = query(params);
		expect(selected.cabinetIds).toEqual([cabinet]);
		expect(selected.binIds).toEqual([elsewhere]);
		expect(serializeCatalogQuery(selected).toString()).toBe(params);
		expect(hasCatalogFilters(query(`bin=${first}`))).toBe(true);
		expect(hasCatalogFilters(query(`cabinet=${cabinet}`))).toBe(true);
		for (const invalid of ['cabinet=', 'bin=bad', `bin=${first}&bin=${first}`, `cabinet=${cabinet}&cabinet=${cabinet}`]) {
			expect(() => query(invalid)).toThrow('invalidFilter');
		}
		expect(() => query(Array.from({ length: 101 }, (_, i) => `cabinet=00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join('&'))).toThrow('invalidFilter');
	});

	test('finds localized category labels while preserving stored filter identities', () => {
		const part = product(1, { name_nb: 'Del 1', name_en: 'Part 1', description: null });
		for (const term of ['Kondensator', 'Capacitor', 'Capacitors']) {
			expect(searchCatalog([part], query(`q=${term}&category=Capacitors`)).products).toEqual([part]);
		}
		expect(() => searchCatalog([part], query('category=Kondensator'))).toThrow('unknownCategory');
		const custom = product(2, { category_name: 'Custom parts' });
		expect(searchCatalog([custom], query('q=Custom&category=Custom+parts')).products).toEqual([custom]);
	});

	test('round-trips and matches any of multiple selected categories', () => {
		const capacitor = product(1);
		const resistor = product(2, { category_name: 'Resistors', attributes: {} });
		const selected = query('category=Capacitors&category=Resistors');
		expect(selected.categories).toEqual(['Capacitors', 'Resistors']);
		expect(serializeCatalogQuery(selected).toString()).toBe('category=Capacitors&category=Resistors');
		expect(searchCatalog([capacitor, resistor], selected).products).toEqual([capacitor, resistor]);
		expect(() => query('category=Capacitors&category=Capacitors')).toThrow(CatalogQueryError);
	});

	test('matches both saved and SI-formatted measurement text', () => {
		const part = product(1, { name_nb: '1000 ohm motstand', name_en: '1000 ohm resistor',
			category_name: 'Resistors', attributes: { resistance: { label: 'Resistance', value_type: 'number', unit: 'ohm', value: '1000' } } });
		for (const term of ['1000 ohm', '1 kΩ', '1k', '1kΩ']) {
			expect(searchCatalog([part], query(`q=${encodeURIComponent(term)}`)).products).toEqual([part]);
		}
		const unnamed = { ...part, name_nb: 'Del 1', name_en: 'Part 1' };
		expect(searchCatalog([unnamed], query('q=1+kΩ')).products).toEqual([unnamed]);
	});

	test('combines text, category, exact text, boolean and inclusive exact numeric bounds', () => {
		const a = product(1);
		const b = product(2, { attributes: { ...a.attributes, capacitance: { label: 'Capacitance', value_type: 'number', unit: 'F', value: '0.00000001' } } });
		const missing = product(3, { attributes: {} });
		const conditions = query('q=CERAMIC+filters+0603&category=Capacitors&min.capacitance=0.000000000005&max.capacitance=0.000000000005&eq.package=0603&eq.polarized=false');
		expect(searchCatalog([a, b, missing], conditions).products.map((p) => p.code)).toEqual([a.code]);
		expect(searchCatalog([a, b, missing], query('category=Capacitors')).total).toBe(3);
		expect(searchCatalog([a, missing], query('eq.polarized=false')).products).toEqual([a]);
	});

	test('compares values beyond exact JavaScript integers and converts tiny engineering units without rounding', () => {
		expect(canonicalFilterNumber('5', -12, 'en')).toBe('0.000000000005');
		expect(canonicalFilterNumber('1,25', -9, 'nb')).toBe('0.00000000125');
		const large = product(1, { attributes: { value: { label: 'Value', value_type: 'number', unit: null, value: '9007199254740993.000000000001' } } });
		expect(searchCatalog([large], query('min.value=9007199254740993.000000000002')).total).toBe(0);
		expect(searchCatalog([large], query('eq.value=9007199254740993.000000000001')).total).toBe(1);
		expect(engineeringUnits('F')).toContainEqual({ symbol: 'pF', exponent: -12 });
		expect(engineeringUnits('custom')).toEqual([{ symbol: 'custom', exponent: 0 }]);
		expect(engineeringUnits('constructor')).toEqual([{ symbol: 'constructor', exponent: 0 }]);
	});

	test('preserves database order and locates cursors by identity under a thousand-product workload', () => {
		const products = Array.from({ length: 1000 }, (_, index) => product(index));
		// Deliberately unlike a JS lexical order: never infer a database collation.
		[products[1], products[900]] = [products[900], products[1]];
		const first = searchCatalog(products, query());
		expect(first.total).toBe(1000);
		expect(first.products[1].code).toBe('CAP-00900');
		const next = searchCatalog(products, query(`after=${first.nextAfterCode}`));
		expect(next.products[0]).toBe(products[50]);
		expect(searchCatalog(products, query('q=CAP-00999')).products[0]).toBe(products[999]);
		expect(() => searchCatalog(products, query('after=REMOVED'))).toThrow('missingCursor');
	});

	test('rejects malformed, conflicting, unknown or wrong-type filters before matching', () => {
		for (const search of ['q=a&q=b', 'after=bad code', 'q=' + 'x'.repeat(201), 'eq.capacitance=1&min.capacitance=0']) {
			expect(() => query(search)).toThrow(CatalogQueryError);
		}
		for (const search of [
			'category=Unknown', 'eq.absent=1', 'min.package=1', 'eq.polarized=no',
			'min.capacitance=2&max.capacitance=1', 'min.capacitance=NaN', 'eq.capacitance=1e-12', 'eq.capacitance='
		]) expect(() => searchCatalog([product(1)], query(search))).toThrow(CatalogQueryError);
		expect(() => searchCatalog([], query('eq.absent=1'))).toThrow('unknownAttribute');
	});

	test('keeps facet choices independent of other conditions and uses case-sensitive text equality', () => {
		const a = product(1);
		const b = product(2, { name_en: 'STRASSE µ controller', attributes: { ...a.attributes, package: { label: 'Package', unit: null, value_type: 'text', value: 'SoT-23' } } });
		expect(catalogFacets([a, b], ['Capacitors']).attributes.find((facet) => facet.code === 'package')?.values).toEqual(['0603', 'SoT-23']);
		const large = product(4, { attributes: { ...a.attributes, capacitance: { label: 'Capacitance', value_type: 'number', unit: 'F', value: '0.00000001' } } });
		const duplicate = product(5, { attributes: { ...a.attributes, capacitance: { label: 'Capacitance', value_type: 'number', unit: 'F', value: '0.000000000005000' } } });
		// Numeric facet values arrive normalized, deduplicated and in decimal order: the slider ticks.
		expect(catalogFacets([large, a, duplicate], ['Capacitors']).attributes.find((facet) => facet.code === 'capacitance')?.values)
			.toEqual(['0.000000000005', '0.00000001']);
		expect(searchCatalog([a, b], query('eq.package=sot-23')).total).toBe(0);
		expect(searchCatalog([a, b], query('q=straße+μ')).products).toEqual([b]);
		const empty = product(3, { attributes: { package: { label: 'Package', unit: null, value_type: 'text', value: '' } } });
		expect(searchCatalog([empty], query('eq.package=')).products).toEqual([empty]);
	});

	test('lists categories without combining incompatible attribute definitions', () => {
		const a = product(1);
		const b = product(2, { category_name: 'Resistors', attributes: {
			capacitance: { label: 'Tolerance', value_type: 'text', unit: null, value: '5%' }
		} });
		expect(catalogCategories([a, b])).toEqual(['Capacitors', 'Resistors']);
	});

	test('round-trips only recognized fields and treats prototype-named attribute codes as data', () => {
		const clean = sanitizeCatalogQuery(new URLSearchParams('q=part&token=secret&eq.constructor=thing&eq.__proto__=bad'));
		expect(clean.toString()).toBe('q=part&eq.constructor=thing');
		const parsed = parseCatalogQuery(clean);
		expect(Object.entries(parsed.conditions)).toContainEqual(['constructor', { eq: 'thing' }]);
		expect(serializeCatalogQuery(parsed).toString()).toBe(clean.toString());
		expect(Object.hasOwn(Object, 'eq')).toBe(false);
		expect(normalizeProductCode(' res-a3f09 ')).toBe('RES-A3F09');
		expect(() => normalizeProductCode('https://elsewhere.invalid')).toThrow(CatalogQueryError);
	});
});
