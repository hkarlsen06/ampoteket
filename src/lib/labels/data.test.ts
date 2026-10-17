import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { ConvexCaller } from '../convex';
import { readLabelData, selectedLabelProducts, labelSpecificationLines, type LabelData } from './data';
import { productTypes, type AdminProduct } from '../admin-products';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const attribute = (product: number, definition: number) => ({ product_id: id(product), attribute_id: id(definition), number_value: '0.000000000005', number_max: null, text_value: null, boolean_value: null });
/** The label reads, answered from a fixture by function name. */
function stub(data: LabelData, attributes: unknown[] = data.attributes) {
	const { units: _, ...references } = data.references;
	const answers: Record<string, unknown> = { 'products:list': data.products, 'products:attributes': attributes, 'products:references': { ...references, units: [] }, 'catalog:shelfMap': data.references.shelf };
	const call = async (fn: FunctionReference<'query'>) => answers[getFunctionName(fn)];
	return { userId: id(99), client: { query: call, mutation: call, action: call } as unknown as ConvexCaller };
}
test('label data keeps exact values and rejects a specification of an unknown product or definition', async () => {
	const data = fixture();
	expect((await readLabelData(stub(data, [attribute(1, 10)]))).attributes[0].number_value).toBe('0.000000000005');
	await expect(readLabelData(stub(data, [attribute(9, 10)]))).rejects.toThrow('relationship');
	await expect(readLabelData(stub(data, [attribute(1, 19)]))).rejects.toThrow('relationship');
	await expect(readLabelData(stub({ ...data, products: [{ ...data.products[0], bin_id: id(29) }] }))).rejects.toThrow('Placement');
});

function fixture(): LabelData {
	const product = (n: number, bin: string | null, active = true): AdminProduct => ({ id: id(n), code: `RES-${n}`, name_nb: 'Motstand', name_en: 'Resistor', bin_id: bin, location_note: null, is_active: active, category_id: productTypes[0].id, unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', metadata_revision: '1', description: null, datasheet_url: null, purchase_url: null });
	return {
		products: [product(1, id(21)), product(2, id(21), false), product(3, id(22)), product(4, null, false)],
		references: { categories: [{ id: productTypes[0].id, name: 'Resistors' }], units: [],
			definitions: [
				{ id: id(10), code: 'resistance', label: 'Resistance', value_type: 'number', canonical_unit: 'ohm' },
				{ id: id(11), code: 'polarised', label: 'Polarised', value_type: 'boolean', canonical_unit: null },
				{ id: id(12), code: 'package', label: 'Package', value_type: 'text', canonical_unit: null }
			], shelf: { cabinets: [{ id: id(20), code: 'C-1', label: null, outer_row: 1, outer_col: 1, inner_rows: 2, inner_cols: 1 }],
				bins: [1, 2].map(row => ({ id: id(20 + row), code: `B-${row}`, cabinet_id: id(20), inner_row: row, inner_col: 1, row_span: 1, col_span: 1, label: null, has_products: true })) } },
		attributes: [
			{ ...attribute(1, 10), number_value: '1000' },
			{ ...attribute(1, 11), number_value: null, number_max: null, boolean_value: false },
			{ ...attribute(1, 12), number_value: null, number_max: null, text_value: '' }
		]
	};
}
test('drawer selection includes every assigned product once, including inactive products; unplaced is explicit', () => {
	const data = fixture();
	expect(selectedLabelProducts(data, [id(21), id(21)], false).map(p => p.id)).toEqual([id(1), id(2)]);
	expect(selectedLabelProducts(data, [id(21), id(22)], true).map(p => p.id)).toEqual([id(3), id(1), id(2), id(4)]);
	expect(selectedLabelProducts(data, [], false)).toEqual([]);
});
test('label specifications retain exact SI values, false, locale and explicit ordering without inventing missing fields; unit values drop the field name', () => {
	const data = fixture(), product = data.products[0];
	expect(labelSpecificationLines(data, product, 'en', [id(11), id(10), id(12)])).toEqual(['Polarised: No', '1 kΩ']);
	expect(labelSpecificationLines(data, product, 'nb', null)).toEqual(['1 kΩ']);
	expect(labelSpecificationLines(data, data.products[1], 'en', null)).toEqual([]);
});
