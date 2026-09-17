import type { CatalogAttribute, CatalogProduct } from './catalog';
import type { ShelfTopology } from './shelf-map';
import { compareDecimals, normalizeDecimal, shiftDecimal } from './decimal';
import { categoryLabel, specificationLabel, locales, messagesFor } from './i18n';
import { engineeringUnits, formatMeasurement, formatMeasurementText } from './format';
import { standardSpecifications } from './product-specifications';

const codePattern = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const attributePattern = /^(eq|min|max)\.([a-z][a-z0-9_]{0,63})$/;
const locationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type CatalogConditions = Record<string, { eq?: string; min?: string; max?: string }>;
export type CatalogLocations = { cabinetIds: string[]; binIds: string[] };
export type CatalogQuery = CatalogLocations & { q: string; categories: string[]; after: string; conditions: CatalogConditions };
export type CatalogQueryIssue = 'invalidQuery' | 'unknownCategory' | 'unknownAttribute' | 'invalidFilter' | 'missingCursor';
export class CatalogQueryError extends Error {
	constructor(readonly issue: CatalogQueryIssue) { super(issue); this.name = 'CatalogQueryError'; }
}

export function normalizeProductCode(value: string): string {
	const code = value.trim().toUpperCase();
	if (!codePattern.test(code)) throw new CatalogQueryError('invalidQuery');
	return code;
}

/** Search aliases never change the saved code or remove punctuation from names. */
export function productSearchText(product: Pick<CatalogProduct, 'code' | 'name_nb' | 'name_en'>): string {
	return `${product.code} ${product.name_nb} ${product.name_en} ${product.code.replaceAll('-', '')}`;
}

/** Allowlist query keys; unknown URL fields never enter links or metadata. */
export function sanitizeCatalogQuery(params: URLSearchParams): URLSearchParams {
	const result = new URLSearchParams();
	for (const [key, value] of params) {
		if (['code', 'q', 'category', 'cabinet', 'bin', 'after'].includes(key) || attributePattern.test(key)) {
			// Preserve repeated category/location selections; duplicates are validated below.
			result.append(key, value);
		}
	}
	return result;
}

export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
	const clean = sanitizeCatalogQuery(params);
	for (const key of clean.keys()) {
		if (!['category', 'cabinet', 'bin'].includes(key) && clean.getAll(key).length !== 1) throw new CatalogQueryError('invalidQuery');
	}
	const q = (clean.get('q') ?? '').trim();
	const categories = clean.getAll('category');
	if ([...q].length > 200 || categories.length > 100 || categories.some((category) => !category || [...category].length > 100)
		|| new Set(categories).size !== categories.length) throw new CatalogQueryError('invalidQuery');
	const after = clean.get('after') || '';
	if (after && !codePattern.test(after)) throw new CatalogQueryError('invalidQuery');
	const cabinetIds = clean.getAll('cabinet'), binIds = clean.getAll('bin');
	if (cabinetIds.length > 100 || binIds.length > 4096
		|| [cabinetIds, binIds].some((ids) => new Set(ids).size !== ids.length || ids.some((id) => !locationPattern.test(id)))) {
		throw new CatalogQueryError('invalidFilter');
	}
	const conditions: CatalogConditions = Object.create(null);
	for (const [key, value] of clean) {
		const match = attributePattern.exec(key);
		if (!match) continue;
		const [, operator, code] = match;
		if ([...value].length > 2000 || (value === '' && operator !== 'eq')) throw new CatalogQueryError('invalidFilter');
		conditions[code] ??= {};
		conditions[code][operator as 'eq' | 'min' | 'max'] = value;
	}
	for (const condition of Object.values(conditions)) {
		if (condition.eq !== undefined && (condition.min !== undefined || condition.max !== undefined)) {
			throw new CatalogQueryError('invalidFilter');
		}
	}
	return { q, categories, after, conditions, cabinetIds, binIds };
}

export function serializeCatalogQuery(query: CatalogQuery): URLSearchParams {
	const result = new URLSearchParams();
	if (query.q) result.set('q', query.q);
	for (const category of query.categories) result.append('category', category);
	for (const id of query.cabinetIds) result.append('cabinet', id);
	for (const id of query.binIds) result.append('bin', id);
	for (const [code, condition] of Object.entries(query.conditions)) {
		for (const operator of ['eq', 'min', 'max'] as const) {
			if (condition[operator] !== undefined) result.set(`${operator}.${code}`, condition[operator]);
		}
	}
	if (query.after) result.set('after', query.after);
	return result;
}

export function hasCatalogFilters(query: CatalogQuery): boolean {
	return Boolean(query.q || query.categories.length || query.cabinetIds.length || query.binIds.length || Object.keys(query.conditions).length);
}

/** Whole cabinets stay compact in shared URLs; partial selections keep stable drawer IDs. */
export function catalogLocations(topology: ShelfTopology, selected: string[]): CatalogLocations {
	const chosen = new Set(selected);
	const cabinetIds = topology.cabinets.filter((cabinet) => {
		const bins = topology.bins.filter((bin) => bin.cabinet_id === cabinet.id);
		return bins.length && bins.every((bin) => chosen.has(bin.id));
	}).map((cabinet) => cabinet.id);
	const covered = new Set(topology.bins.filter((bin) => cabinetIds.includes(bin.cabinet_id)).map((bin) => bin.id));
	return { cabinetIds, binIds: selected.filter((id) => !covered.has(id)) };
}

export function catalogCategories(products: CatalogProduct[]): string[] {
	return [...new Set(products.flatMap((product) => product.category_name === null ? [] : [product.category_name]))];
}

/** Numeric facet values are normalized, deduplicated and sorted ascending: the slider's tick positions. */
export type CatalogFacet = { code: string; definition: CatalogAttribute; values: string[] };
export type CatalogFacets = { categories: string[]; attributes: CatalogFacet[] };

/** SQL search shares the exact display dictionaries and engineering prefixes. */
export function catalogSearchLabels() {
	return {
		categories: Object.fromEntries(Object.keys(messagesFor('nb').categories).map(key => [key, locales.map(locale => categoryLabel(key, locale)).join(' ')])),
		attributes: Object.fromEntries(standardSpecifications.map(definition => [definition.code, {
			value_type: definition.value_type, unit: definition.canonical_unit,
			labels: locales.map(locale => specificationLabel(definition.code, definition, locale)).join(' ')
		}])),
		units: Object.fromEntries(['ohm', 'Ω', 'F', 'H', 'V', 'A', 'W', 'Hz', 'm'].map(unit => [unit, engineeringUnits(unit)]))
	};
}

export function catalogFacets(products: CatalogProduct[], selectedCategories: string[]): CatalogFacets {
	const categories = catalogCategories(products);
	const definitions = new Map<string, CatalogFacet>();
	for (const product of products) {
		if (selectedCategories.length && (product.category_name === null || !selectedCategories.includes(product.category_name))) continue;
		for (const [code, definition] of Object.entries(product.attributes)) {
			const existing = definitions.get(code);
			if (existing) {
				if (existing.definition.value_type !== definition.value_type || existing.definition.unit !== definition.unit
					|| existing.definition.label !== definition.label) throw new CatalogQueryError('invalidFilter');
				if (definition.value_type === 'text' && !existing.values.includes(definition.value)) existing.values.push(definition.value);
				else if (definition.value_type === 'number') {
					const value = normalizeDecimal(definition.value);
					if (!existing.values.includes(value)) existing.values.push(value);
				}
			} else definitions.set(code, { code, definition, values: definition.value_type === 'text' ? [definition.value]
				: definition.value_type === 'number' ? [normalizeDecimal(definition.value)] : [] });
		}
	}
	const attributes = [...definitions.values()];
	for (const facet of attributes) {
		if (facet.definition.value_type === 'number') facet.values.sort(compareDecimals);
	}
	return { categories, attributes };
}

function folded(text: string): string {
	return text.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
}

/** Validate every supplied condition before matching, including on an empty result set. */
export function searchCatalog(products: CatalogProduct[], query: CatalogQuery, limit = 50): {
	products: CatalogProduct[]; total: number; nextAfterCode: string | null;
} {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid catalog page size');
	const availableCategories = new Set(catalogCategories(products));
	if (query.categories.some((category) => !availableCategories.has(category))) throw new CatalogQueryError('unknownCategory');
	const definitions = new Map(Object.keys(query.conditions).length
		? catalogFacets(products, query.categories).attributes.map((facet) => [facet.code, facet.definition])
		: []);
	for (const [code, condition] of Object.entries(query.conditions)) {
		const definition = definitions.get(code);
		if (!definition) throw new CatalogQueryError('unknownAttribute');
		if (condition.eq !== undefined && (condition.min !== undefined || condition.max !== undefined)) throw new CatalogQueryError('invalidFilter');
		if (definition.value_type !== 'number' && (condition.min !== undefined || condition.max !== undefined)) throw new CatalogQueryError('invalidFilter');
		if (definition.value_type === 'boolean' && condition.eq !== 'true' && condition.eq !== 'false') throw new CatalogQueryError('invalidFilter');
		if (definition.value_type === 'number') {
			try {
				for (const value of Object.values(condition)) normalizeDecimal(value);
				if (condition.min !== undefined && condition.max !== undefined && compareDecimals(condition.min, condition.max) > 0) throw new Error();
			} catch { throw new CatalogQueryError('invalidFilter'); }
		}
	}
	const cursor = query.after ? products.findIndex((product) => product.code === query.after) : -1;
	if (query.after && cursor === -1) throw new CatalogQueryError('missingCursor');
	const terms = folded(query.q).split(/\s+/).filter(Boolean);
	const matches: { product: CatalogProduct; index: number }[] = [];
	for (const [index, product] of products.entries()) {
		if (query.categories.length && (product.category_name === null || !query.categories.includes(product.category_name))) continue;
		const searchable = folded([productSearchText(product), product.description, product.category_name,
			formatMeasurementText(product.name_nb, 'nb'), formatMeasurementText(product.name_en, 'en'),
			...locales.map((locale) => product.category_name ? categoryLabel(product.category_name, locale) : null),
			...Object.entries(product.attributes).map(([code, attribute]) => [attribute.label, ...locales.map(locale => specificationLabel(code, attribute, locale)),
				attribute.value_type === 'boolean' ? (attribute.value ? 'true yes ja' : 'false no nei') : attribute.value,
				...(attribute.value_type === 'number' ? locales.map((locale) => formatMeasurement(attribute.value, attribute.unit, locale)) : []),
				attribute.unit].filter((part) => part !== null).join(' '))].filter((part) => part !== null).join(' '));
		if (!terms.every((term) => searchable.includes(term))) continue;
		if (!Object.entries(query.conditions).every(([code, condition]) => {
			const attribute = product.attributes[code];
			if (!attribute) return false;
			if (attribute.value_type === 'number') return (condition.eq === undefined || compareDecimals(attribute.value, condition.eq) === 0)
				&& (condition.min === undefined || compareDecimals(attribute.value, condition.min) >= 0)
				&& (condition.max === undefined || compareDecimals(attribute.value, condition.max) <= 0);
			return String(attribute.value) === condition.eq;
		})) continue;
		matches.push({ product, index });
	}
	const following = matches.filter((match) => match.index > cursor);
	const page = following.slice(0, limit).map((match) => match.product);
	return { products: page, total: matches.length, nextAfterCode: following.length > limit ? page.at(-1)!.code : null };
}

/** Exponents are relative to the API definition's canonical unit; no guessed units. */
export { engineeringUnits } from './format';

export function canonicalFilterNumber(input: string, exponent: number, locale: 'nb' | 'en'): string {
	return shiftDecimal(normalizeDecimal(input, locale), exponent);
}
