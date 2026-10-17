/**
 * The public catalog, shelf map and volunteer directory (docs/api-contract.md).
 *
 * Public queries expose no costs, contacts, tokens, staff identities, checkout
 * history or internal notes. Search uses the same TypeScript as the shop
 * (src/lib/catalog-search.ts), and the category order and look-alike rules come
 * from src/lib/product-specifications.ts, so the client no longer sends them.
 */
import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { catalogSearchText, matchesSearch, searchTerms } from '../src/lib/catalog-search';
import type { CatalogAttribute, CatalogProduct } from '../src/lib/catalog-types';
import { catalogSort } from '../src/lib/product-specifications';
import { compareDecimals, isDecimal, trimScale } from './lib/decimal';
import { fail } from './lib/errors';
import { isUuid } from './lib/ids';
import { stockLevel } from './lib/inventory';

type SortKey = { rank: number; category: string; missing: boolean; number: string; text: string };
type Loaded = {
	product: Doc<'products'>; category: string | null; values: Map<string, Doc<'product_attributes'>>;
	attributes: Record<string, CatalogAttribute>; key: SortKey;
	/** Public fields except stock and placement, which `publish` adds for the rows a call returns. */
	row: CatalogProduct;
};
const collator = new Intl.Collator('en');
const sortEntries = new Map(catalogSort.map(([category, primary, ordered], index) => [category, { rank: index + 1, primary, ordered }]));

/**
 * Every active product with what search, filters and ordering need, in catalog
 * order. Reads scale with the catalog, so stock and drawers are left to `publish`.
 */
async function activeCatalog(ctx: QueryCtx): Promise<Loaded[]> {
	const definitions = new Map((await ctx.db.query('attribute_definitions').collect()).map((d) => [d.id, d]));
	const categories = new Map((await ctx.db.query('categories').collect()).map((c) => [c.id, c.name]));
	const units = new Map((await ctx.db.query('units').collect()).map((u) => [u.code, u.symbol]));
	const products = await ctx.db.query('products').withIndex('is_active_code', (q) => q.eq('is_active', true)).collect();
	const loaded: Loaded[] = [];
	for (const product of products) {
		const values = new Map<string, Doc<'product_attributes'>>();
		const attributes: Record<string, CatalogAttribute> = {};
		for (const value of await ctx.db.query('product_attributes').withIndex('product_attribute', (q) => q.eq('product_id', product.id)).collect()) {
			const d = definitions.get(value.attribute_id)!;
			values.set(d.code, value);
			attributes[d.code] = d.value_type === 'number' ? { label: d.label, unit: d.canonical_unit, value_type: 'number', value: value.number_value!, max: value.number_max }
				: d.value_type === 'text' ? { label: d.label, unit: null, value_type: 'text', value: value.text_value! }
				: { label: d.label, unit: null, value_type: 'boolean', value: value.boolean_value! };
		}
		const category = product.category_id ? categories.get(product.category_id) ?? null : null;
		const row = {
			product_id: product.id, code: product.code, name_nb: product.name_nb, name_en: product.name_en, description: product.description,
			category_name: category, unit_code: product.unit_code, unit_symbol: units.get(product.unit_code) ?? product.unit_code,
			sale_step: product.sale_step, sale_unit_price_nok: product.sale_unit_price_nok, quantity: '0', last_counted_at: null,
			datasheet_url: product.datasheet_url, attributes, distinguishing: [],
			cabinet_code: null, outer_row: null, outer_col: null, inner_rows: null, inner_cols: null, bin_code: null, bin_label: null,
			inner_row: null, inner_col: null, row_span: null, col_span: null, location_note: product.location_note
		} as CatalogProduct;
		const item = { product, category, values, attributes, row } as Loaded;
		item.key = sortKey(item);
		loaded.push(item);
	}
	return loaded.sort(compareCatalogOrder);
}

/** Add stock and placement to the rows being returned (a page, or one product). */
async function publish(ctx: QueryCtx, items: Loaded[], rows: CatalogProduct[]): Promise<CatalogProduct[]> {
	return await Promise.all(items.map(async (item, index) => {
		const product = item.product;
		const stock = await stockLevel(ctx, product.id);
		const bin = product.bin_id ? await ctx.db.query('bins').withIndex('uuid', (q) => q.eq('id', product.bin_id!)).unique() : null;
		const cabinet = bin?.cabinet_id ? await ctx.db.query('cabinets').withIndex('uuid', (q) => q.eq('id', bin.cabinet_id!)).unique() : null;
		const placement = bin && cabinet && !bin.is_archived && !cabinet.is_archived
			? { cabinet_code: cabinet.code, outer_row: cabinet.outer_row!, outer_col: cabinet.outer_col!, inner_rows: cabinet.inner_rows, inner_cols: cabinet.inner_cols,
				bin_code: bin.code, bin_label: bin.label, inner_row: bin.inner_row!, inner_col: bin.inner_col!, row_span: bin.row_span, col_span: bin.col_span, location_note: null }
			: { cabinet_code: null, outer_row: null, outer_col: null, inner_rows: null, inner_cols: null, bin_code: null, bin_label: null,
				inner_row: null, inner_col: null, row_span: null, col_span: null, location_note: product.location_note };
		return { ...rows[index], quantity: stock.quantity, last_counted_at: stock.last_counted_at, ...placement } as CatalogProduct;
	}));
}

/** Listed categories first by their primary value (missing last), others by name, uncategorised last; then name and code. */
function sortKey(item: Omit<Loaded, 'key'>): SortKey {
	const entry = item.category === null ? undefined : sortEntries.get(item.category);
	const value = entry?.primary ? item.values.get(entry.primary) : undefined;
	return { rank: entry?.rank ?? (item.category === null ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1), category: item.category ?? '',
		missing: !value || (value.number_value === null && value.text_value === null), number: value?.number_value ?? '0', text: value?.text_value ?? '' };
}
function compareCatalogOrder(a: Loaded, b: Loaded): number {
	const x = a.key, y = b.key;
	return x.rank - y.rank || collator.compare(x.category, y.category) || Number(x.missing) - Number(y.missing)
		|| compareDecimals(x.number, y.number) || collator.compare(x.text, y.text)
		|| collator.compare(a.product.name_nb, b.product.name_nb) || collator.compare(a.product.code, b.product.code);
}

/** A comparable specification value; empty text counts as missing (app.catalog_value_key). */
function valueKey(value: Doc<'product_attributes'> | undefined): unknown {
	if (!value) return null;
	if (value.number_max !== null) return [trimScale(value.number_value!), trimScale(value.number_max)];
	if (value.number_value !== null) return trimScale(value.number_value);
	if (value.text_value !== null && value.text_value !== '') return value.text_value;
	return value.boolean_value;
}

/**
 * Up to two specification codes that tell each listed product from its active
 * look-alikes: same category and primary value or, without one, the same name
 * (app.catalog_distinguishing). Every member of a group gets the same list.
 */
function distinguishing(all: Loaded[], listed: Loaded[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	const listedIds = new Set(listed.map((item) => item.product.id));
	const listedCategories = new Set(listed.map((item) => item.product.category_id));
	const groups = new Map<string, Loaded[]>();
	for (const item of all) {
		if (!listedCategories.has(item.product.category_id)) continue;
		const entry = item.category === null ? undefined : sortEntries.get(item.category);
		const primary = entry?.primary ?? null;
		const primaryKey = primary ? valueKey(item.values.get(primary)) : null;
		const key = primaryKey !== null ? ['value', primaryKey] : ['name', item.product.name_nb.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()];
		const group = JSON.stringify([item.product.category_id, key]);
		groups.set(group, [...(groups.get(group) ?? []), item]);
	}
	for (const members of groups.values()) {
		if (members.length < 2 || !members.some((m) => listedIds.has(m.product.id))) continue;
		const entry = members[0].category === null ? undefined : sortEntries.get(members[0].category);
		const primary = entry?.primary ?? null;
		const candidates = (entry?.ordered ?? []).filter((code) => code !== primary);
		const others = new Set<string>();
		for (const m of members) for (const code of m.values.keys()) if (code !== primary && !candidates.includes(code)) others.add(code);
		candidates.push(...[...others].sort());
		const codes: string[] = [];
		let groupCount = 1;
		for (const code of candidates) {
			if (codes.length === 2 || groupCount === members.length) break;
			const next = new Set(members.map((m) => JSON.stringify([...codes, code].map((c) => valueKey(m.values.get(c)))))).size;
			if (next > groupCount) { codes.push(code); groupCount = next; }
		}
		for (const m of members) if (listedIds.has(m.product.id)) result.set(m.product.id, codes);
	}
	return result;
}

function withDistinguishing(all: Loaded[], page: Loaded[]): CatalogProduct[] {
	const codes = distinguishing(all, page);
	return page.map((item) => ({ ...item.row, distinguishing: codes.get(item.product.id) ?? [] }));
}

const condition = v.object({ eq: v.optional(v.string()), min: v.optional(v.string()), max: v.optional(v.string()) });

/** Validate the query against the live catalog before matching (app.check_catalog_query). */
function checkQuery(all: Loaded[], args: { q: string; categories: string[]; conditions: Record<string, typeof condition.type> }) {
	if ([...args.q].length > 200 || args.categories.length > 100 || new Set(args.categories).size !== args.categories.length
		|| args.categories.some((c) => !c || [...c].length > 100)) fail('INVALID_CATALOG_QUERY');
	const known = new Set(all.flatMap((item) => item.category === null ? [] : [item.category]));
	if (args.categories.some((c) => !known.has(c))) fail('UNKNOWN_CATALOG_CATEGORY');
	const scoped = all.filter((item) => !args.categories.length || (item.category !== null && args.categories.includes(item.category)));
	for (const [code, c] of Object.entries(args.conditions)) {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || (c.eq === undefined && c.min === undefined && c.max === undefined)
			|| (c.eq !== undefined && (c.min !== undefined || c.max !== undefined))) fail('INVALID_CATALOG_FILTER');
		const attribute = scoped.find((item) => item.attributes[code])?.attributes[code];
		if (!attribute) fail('UNKNOWN_CATALOG_ATTRIBUTE');
		for (const [operator, raw] of Object.entries(c)) {
			if (raw === undefined) continue;
			if ([...raw].length > 2000 || (operator !== 'eq' && attribute.value_type !== 'number')) fail('INVALID_CATALOG_FILTER');
			const value = raw.trim();
			if (attribute.value_type === 'number' && !/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/.test(value)) fail('INVALID_CATALOG_FILTER');
			if (attribute.value_type === 'boolean' && raw !== 'true' && raw !== 'false') fail('INVALID_CATALOG_FILTER');
		}
		if (attribute.value_type === 'number' && c.min !== undefined && c.max !== undefined && compareDecimals(exact(c.min), exact(c.max)) > 0) fail('INVALID_CATALOG_FILTER');
	}
}
/** "+.5" → "0.5": the filter grammar accepts what SQL numeric did. */
function exact(value: string): string {
	let text = value.trim().replace(/^\+/, '');
	const negative = text.startsWith('-');
	if (negative) text = text.slice(1);
	if (text.startsWith('.')) text = `0${text}`;
	if (text.endsWith('.')) text = text.slice(0, -1);
	return isDecimal(text) ? (negative ? `-${text}` : text) : fail('INVALID_CATALOG_FILTER');
}
function matchesConditions(item: Loaded, conditions: Record<string, typeof condition.type>): boolean {
	return Object.entries(conditions).every(([code, c]) => {
		const attribute = item.attributes[code];
		if (!attribute) return false;
		if (attribute.value_type !== 'number') return String(attribute.value) === c.eq;
		// A range matches a condition it overlaps.
		const upper = attribute.max ?? attribute.value;
		return (c.eq === undefined || (compareDecimals(attribute.value, exact(c.eq)) <= 0 && compareDecimals(upper, exact(c.eq)) >= 0))
			&& (c.min === undefined || compareDecimals(upper, exact(c.min)) >= 0)
			&& (c.max === undefined || compareDecimals(attribute.value, exact(c.max)) <= 0);
	});
}

/**
 * One page of active products in catalog order, after `afterCode`. `complete`
 * says no matching product follows this page.
 */
export const page = query({
	args: {
		q: v.optional(v.string()), categories: v.optional(v.array(v.string())), conditions: v.optional(v.record(v.string(), condition)),
		cabinetIds: v.optional(v.array(v.string())), binIds: v.optional(v.array(v.string())), binId: v.optional(v.string()),
		afterCode: v.optional(v.string()), limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 200;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID_CATALOG_PAGE_SIZE');
		const q = args.q ?? '', categories = args.categories ?? [], conditions = args.conditions ?? {};
		const cabinetIds = args.cabinetIds ?? [], binIds = args.binIds ?? [];
		const all = await activeCatalog(ctx);
		checkQuery(all, { q, categories, conditions });
		if (cabinetIds.length > 100 || binIds.length > 4096 || new Set(cabinetIds).size !== cabinetIds.length || new Set(binIds).size !== binIds.length) fail('INVALID_CATALOG_FILTER');
		for (const id of cabinetIds) {
			const cabinet = isUuid(id) ? await ctx.db.query('cabinets').withIndex('uuid', (x) => x.eq('id', id)).unique() : null;
			if (!cabinet || cabinet.is_archived) fail('INVALID_CATALOG_FILTER');
		}
		const binCabinets = new Map<string, string>();
		for (const id of binIds) {
			const bin = isUuid(id) ? await ctx.db.query('bins').withIndex('uuid', (x) => x.eq('id', id)).unique() : null;
			const cabinet = bin?.cabinet_id ? await ctx.db.query('cabinets').withIndex('uuid', (x) => x.eq('id', bin.cabinet_id!)).unique() : null;
			if (!bin || bin.is_archived || !cabinet || cabinet.is_archived) fail('INVALID_CATALOG_FILTER');
		}
		// Drawer-to-cabinet only matters for a cabinet filter.
		if (cabinetIds.length) for (const bin of await ctx.db.query('bins').collect()) if (bin.cabinet_id) binCabinets.set(bin.id, bin.cabinet_id);
		let start = 0;
		if (args.afterCode !== undefined) {
			const index = all.findIndex((item) => item.product.code === args.afterCode);
			if (index < 0) fail('CATALOG_CURSOR_MISSING');
			start = index + 1;
		}
		const terms = searchTerms(q);
		const matches = all.slice(start).filter((item) => {
			const binId = item.product.bin_id;
			if (args.binId !== undefined && binId !== args.binId) return false;
			if ((cabinetIds.length || binIds.length) && !(binId && (binIds.includes(binId) || cabinetIds.includes(binCabinets.get(binId) ?? '')))) return false;
			if (categories.length && (item.category === null || !categories.includes(item.category))) return false;
			return matchesConditions(item, conditions) && (!terms.length || matchesSearch(catalogSearchText(item.row), terms));
		});
		const listed = matches.slice(0, limit);
		return { products: await publish(ctx, listed, withDistinguishing(all, listed)), complete: matches.length <= limit, nextAfterCode: listed.at(-1)?.product.code ?? null };
	}
});

/** One active product by its exact code, or null. */
export const product = query({
	args: { code: v.string() },
	handler: async (ctx, args) => {
		const all = await activeCatalog(ctx);
		const item = all.find((entry) => entry.product.code === args.code);
		return item ? (await publish(ctx, [item], withDistinguishing(all, [item])))[0] : null;
	}
});

/** Categories with active products, and every specification's values within the selected categories. */
export const facets = query({
	args: { categories: v.optional(v.array(v.string())) },
	handler: async (ctx, args) => {
		const categories = args.categories ?? [];
		const all = await activeCatalog(ctx);
		checkQuery(all, { q: '', categories, conditions: {} });
		const byCode = [...all].sort((a, b) => collator.compare(a.product.code, b.product.code));
		const names: string[] = [];
		for (const item of byCode) if (item.category !== null && !names.includes(item.category)) names.push(item.category);
		const facets = new Map<string, { code: string; first: string; definition: CatalogAttribute; values: string[] }>();
		for (const item of byCode) {
			if (categories.length && (item.category === null || !categories.includes(item.category))) continue;
			for (const [code, attribute] of Object.entries(item.attributes)) {
				let facet = facets.get(code);
				if (!facet) facets.set(code, facet = { code, first: item.product.code, definition: attribute, values: [] });
				if (attribute.value_type === 'number') {
					for (const bound of [attribute.value, attribute.max]) if (bound !== null && !facet.values.includes(trimScale(bound))) facet.values.push(trimScale(bound));
				} else if (attribute.value_type === 'text' && !facet.values.includes(attribute.value)) facet.values.push(attribute.value);
			}
		}
		const attributes = [...facets.values()].sort((a, b) => collator.compare(a.first, b.first) || collator.compare(a.code, b.code)).map((facet) => {
			if (facet.definition.value_type === 'number') facet.values.sort(compareDecimals);
			return { code: facet.code, definition: facet.definition, values: facet.values };
		});
		return { categories: names, attributes };
	}
});

/** The complete live wall: cabinets and drawers, with whether any product (even inactive) is assigned. */
export const shelfMap = query({
	args: {},
	handler: async (ctx) => {
		const cabinets = (await ctx.db.query('cabinets').collect()).filter((c) => !c.is_archived)
			.sort((a, b) => a.outer_row! - b.outer_row! || a.outer_col! - b.outer_col! || collator.compare(a.code, b.code));
		const live = new Set(cabinets.map((c) => c.id));
		const assigned = new Set((await ctx.db.query('products').collect()).flatMap((p) => p.bin_id ? [p.bin_id] : []));
		const bins = (await ctx.db.query('bins').collect()).filter((b) => !b.is_archived && b.cabinet_id && live.has(b.cabinet_id))
			.sort((a, b) => collator.compare(a.code, b.code));
		return {
			cabinets: cabinets.map((c) => ({ id: c.id, code: c.code, outer_row: c.outer_row!, outer_col: c.outer_col!, inner_rows: c.inner_rows, inner_cols: c.inner_cols, label: c.label })),
			bins: bins.map((b) => ({ id: b.id, code: b.code, cabinet_id: b.cabinet_id!, inner_row: b.inner_row!, inner_col: b.inner_col!, row_span: b.row_span,
				col_span: b.col_span, label: b.label, has_products: assigned.has(b.id) }))
		};
	}
});

/** Published volunteer contacts in display order; no drafts or edit metadata. */
export const helpDirectory = query({
	args: {},
	handler: async (ctx) => {
		const contacts = await ctx.db.query('help_contacts').withIndex('display_order').collect();
		return contacts.filter((c) => c.is_published).map((c) => ({ id: c.id, display_name: c.display_name, responsibility: c.responsibility, email: c.email,
			phone: c.phone, contact_url: c.contact_url, discord: c.discord, display_order: c.display_order }));
	}
});
