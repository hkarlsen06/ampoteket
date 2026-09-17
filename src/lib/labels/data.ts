import { staffRequest, type StaffSession } from '../admin-api';
import { parseAttribute, readAdminProducts, readProductReferences, productTypes,
	type AdminProduct, type AttributeValue, type ProductReferences } from '../admin-products';
import { categorySpecifications } from '../product-specifications';
import { formatMeasurement, formatMeasurementText } from '../format';
import { messagesFor, specificationLabel, type Locale } from '../i18n';
import type { Fetcher } from '../api';

export type LabelData = { products: AdminProduct[]; references: ProductReferences; attributes: AttributeValue[] };

/** Attributes have a composite key: paging on either UUID alone loses rows. */
export async function readLabelAttributes(session: StaffSession, fetcher: Fetcher = fetch): Promise<AttributeValue[]> {
	const result: AttributeValue[] = [];
	let after: AttributeValue | undefined;
	for (;;) {
		const raw = await staffRequest(session, 'amp_product_attributes', {
			select: 'product_id,attribute_id,number_value,text_value,boolean_value',
			order: 'product_id.asc,attribute_id.asc', limit: '200',
			...(after ? { or: `(product_id.gt.${after.product_id},and(product_id.eq.${after.product_id},attribute_id.gt.${after.attribute_id}))` } : {})
		}, undefined, 'GET', fetcher);
		if (!Array.isArray(raw) || raw.length > 200) throw new Error('Invalid label attribute page');
		if (!raw.length) return result;
		for (const value of raw) {
			const row = parseAttribute(value);
			if (after && (row.product_id < after.product_id || row.product_id === after.product_id && row.attribute_id <= after.attribute_id)) throw new Error('Non-advancing label attribute page');
			result.push(row); after = row;
		}
	}
}

export async function readLabelData(session: StaffSession, fetcher: Fetcher = fetch): Promise<LabelData> {
	const [products, references, attributes] = await Promise.all([
		readAdminProducts(session, fetcher), readProductReferences(session, fetcher), readLabelAttributes(session, fetcher)
	]);
	const bins = new Set(references.shelf.bins.map(bin => bin.id));
	const productIds = new Set(products.map(product => product.id));
	const definitions = new Map(references.definitions.map(definition => [definition.id, definition]));
	if (products.some(product => product.bin_id !== null && !bins.has(product.bin_id))) throw new Error('Placement changed during label read');
	for (const value of attributes) {
		const definition = definitions.get(value.attribute_id);
		if (!productIds.has(value.product_id) || !definition ||
			(definition.value_type === 'number' ? value.number_value === null : definition.value_type === 'text' ? value.text_value === null : value.boolean_value === null)) throw new Error('Invalid label attribute relationship');
	}
	return { products, references, attributes };
}

/** Every saved product in selected drawers, including inactive/zero-stock ones,
 * once only. Print order follows the map, top-to-bottom then left-to-right. */
export function selectedLabelProducts(data: LabelData, drawerIds: readonly string[], includeUnplaced: boolean): AdminProduct[] {
	const selected = new Set(drawerIds);
	const cabinets = [...data.references.shelf.cabinets].sort((a, b) => b.outer_row - a.outer_row || a.outer_col - b.outer_col);
	const order = new Map(cabinets.flatMap(cabinet => data.references.shelf.bins.filter(bin => bin.cabinet_id === cabinet.id)
		.sort((a, b) => b.inner_row + b.row_span - a.inner_row - a.row_span || a.inner_col - b.inner_col)).map((bin, index) => [bin.id, index]));
	return data.products.filter(product => product.bin_id === null ? includeUnplaced : selected.has(product.bin_id) && order.has(product.bin_id))
		.sort((a, b) => (order.get(a.bin_id ?? '') ?? Infinity) - (order.get(b.bin_id ?? '') ?? Infinity) || a.code.localeCompare(b.code));
}

/** null uses the first recorded category-specific field; an explicit list
 * preserves the operator's chosen order. Missing/empty values produce no line.
 * A value with a unit names itself ("10 kΩ"); others keep their field name. */
export function labelSpecificationLines(data: LabelData, product: AdminProduct, locale: Locale, definitionIds: readonly string[] | null): string[] {
	const values = new Map(data.attributes.filter(value => value.product_id === product.id).map(value => [value.attribute_id, value]));
	const definitions = data.references.definitions;
	let ids = definitionIds;
	if (ids === null) {
		const category = data.references.categories.find(item => item.id === product.category_id);
		const family = productTypes.find(type => type.name.toLowerCase() === category?.name.trim().toLowerCase())?.prefix ?? 'MIS';
		const preferred = categorySpecifications[family].flatMap(code => definitions.filter(definition => definition.code === code));
		ids = [...preferred, ...definitions.filter(definition => !preferred.includes(definition))]
			.filter(definition => { const value = values.get(definition.id); return value && value.text_value !== ''; }).slice(0, 1).map(definition => definition.id);
	}
	return [...new Set(ids)].flatMap(id => {
		const definition = definitions.find(item => item.id === id), value = values.get(id);
		if (!definition || !value || value.text_value === '') return [];
		const shown = value.number_value !== null ? formatMeasurement(value.number_value, definition.canonical_unit, locale)
			: value.text_value !== null ? formatMeasurementText(value.text_value, locale)
				: value.boolean_value ? messagesFor(locale).adminProducts.yes : messagesFor(locale).adminProducts.no;
		return [value.number_value !== null && definition.canonical_unit ? shown
			: `${specificationLabel(definition.code, definition, locale)}: ${shown}`];
	});
}
