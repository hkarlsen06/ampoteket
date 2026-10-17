/**
 * Product master data: products, categories, specification definitions and
 * values (datamodell.md Appendix A). All writes are audited.
 *
 * A product command (metadata plus its specification changes) is one
 * transaction. Edits compare against the values the editor showed: the
 * product's `metadata_revision`, and each specification's previous value.
 * A mismatch raises STALE_PRODUCT and changes nothing.
 */
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { productTypes, standardSpecifications } from '../src/lib/product-specifications';
import { deleteAudited, insertAudited, patchAudited, type Actor } from './lib/audit';
import { checkedQuantity, checkedUnitPrice, compareDecimals, isDecimal, isMultipleOf } from './lib/decimal';
import { fail } from './lib/errors';
import { byUuid, isUuid } from './lib/ids';
import { requireStaff } from './lib/staff';
import { isoNow } from './lib/time';

const nullableString = v.union(v.string(), v.null());
const productPayload = v.object({
	id: v.string(), code: v.string(), name_nb: v.string(), name_en: v.string(), description: nullableString,
	category_id: nullableString, bin_id: nullableString, location_note: nullableString, unit_code: v.string(),
	stock_step: v.string(), sale_step: v.string(), sale_unit_price_nok: nullableString, minimum_stock: v.string(),
	datasheet_url: nullableString, purchase_url: nullableString, is_active: v.boolean()
});
type ProductPayload = typeof productPayload.type;
const attributeValue = v.object({
	attribute_id: v.string(), number_value: nullableString, number_max: nullableString, text_value: nullableString, boolean_value: v.union(v.boolean(), v.null())
});
type AttributeValue = typeof attributeValue.type;

export function productRow(p: Doc<'products'>) {
	return { id: p.id, code: p.code, name_nb: p.name_nb, name_en: p.name_en, description: p.description, category_id: p.category_id, bin_id: p.bin_id,
		location_note: p.location_note, unit_code: p.unit_code, stock_step: p.stock_step, sale_step: p.sale_step, sale_unit_price_nok: p.sale_unit_price_nok,
		minimum_stock: p.minimum_stock, datasheet_url: p.datasheet_url, purchase_url: p.purchase_url, is_active: p.is_active,
		metadata_revision: String(p.metadata_revision), created_at: p.created_at };
}
function attributeRow(a: Doc<'product_attributes'>) {
	return { product_id: a.product_id, attribute_id: a.attribute_id, number_value: a.number_value, number_max: a.number_max, text_value: a.text_value, boolean_value: a.boolean_value };
}

// ---------- Validation (the table checks and guard_product) ----------

const textBetween = (value: string, min: number, max: number) => value.trim().length >= min && [...value.trim()].length <= max;
function link(value: string | null): string | null {
	if (value !== null && !/^https?:\/\//.test(value)) fail('INVALID_URL');
	return value;
}
async function checkProduct(ctx: QueryCtx, p: ProductPayload) {
	if (!isUuid(p.id)) fail('INVALID_PRODUCT', 'id');
	if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(p.code)) fail('INVALID_PRODUCT', 'code');
	if (!textBetween(p.name_nb, 1, 200) || !textBetween(p.name_en, 1, 200)) fail('INVALID_PRODUCT', 'name');
	if (p.location_note !== null && !textBetween(p.location_note, 1, 200)) fail('INVALID_PRODUCT', 'location_note');
	if (p.bin_id !== null && p.location_note !== null) fail('INVALID_PRODUCT', 'location_note');
	const unit = await ctx.db.query('units').withIndex('code', (q) => q.eq('code', p.unit_code)).unique() ?? fail('INVALID_PRODUCT', 'unit_code');
	const stock = checkedQuantity(p.stock_step, 'INVALID_PRODUCT'), sale = checkedQuantity(p.sale_step, 'INVALID_PRODUCT');
	const minimum = checkedQuantity(p.minimum_stock, 'INVALID_PRODUCT');
	if (compareDecimals(stock, '0') <= 0 || compareDecimals(sale, '0') <= 0 || compareDecimals(minimum, '0') < 0) fail('INVALID_PRODUCT', 'step');
	if (!isMultipleOf(sale, stock) || !isMultipleOf(minimum, stock)) fail('INVALID_PRODUCT', 'step');
	if (unit.is_discrete && (!isMultipleOf(stock, '1') || !isMultipleOf(sale, '1'))) fail('DISCRETE_UNIT_REQUIRES_WHOLE_QUANTITIES');
	if (p.sale_unit_price_nok !== null) checkedUnitPrice(p.sale_unit_price_nok, 'INVALID_PRODUCT');
	link(p.datasheet_url); link(p.purchase_url);
	if (p.category_id !== null && !await byUuid(ctx, 'categories', p.category_id)) fail('INVALID_PRODUCT', 'category_id');
	if (p.bin_id !== null) {
		const bin = await byUuid(ctx, 'bins', p.bin_id);
		if (!bin || bin.is_archived) fail('PRODUCT_BIN_UNAVAILABLE');
	}
}

/** A standard category is created on first use with its fixed ID; an existing one must match. */
async function ensureCategory(ctx: MutationCtx, actor: Actor, categoryId: string | null) {
	const type = productTypes.find((t) => t.id === categoryId);
	if (!type || await byUuid(ctx, 'categories', type.id)) return;
	if (await ctx.db.query('categories').withIndex('name', (q) => q.eq('name', type.name)).unique()) fail('CATEGORY_NAME_TAKEN');
	await insertAudited(ctx, actor, 'categories', { id: type.id, name: type.name });
}
/** A standard specification is created on first use with its fixed ID. */
async function ensureDefinition(ctx: MutationCtx, actor: Actor, attributeId: string) {
	const standard = standardSpecifications.find((s) => s.id === attributeId);
	if (!standard) return;
	const existing = await byUuid(ctx, 'attribute_definitions', standard.id);
	// A value must never be stored under a standard ID that means something else.
	if (existing) {
		if (existing.code !== standard.code || existing.value_type !== standard.value_type || existing.canonical_unit !== standard.canonical_unit) fail('DEFINITION_ID_TAKEN');
		return;
	}
	if (await ctx.db.query('attribute_definitions').withIndex('code', (q) => q.eq('code', standard.code)).unique()) fail('DEFINITION_CODE_TAKEN');
	await insertAudited(ctx, actor, 'attribute_definitions', { id: standard.id, code: standard.code, label: standard.label, value_type: standard.value_type, canonical_unit: standard.canonical_unit });
}

function sameAttribute(row: Doc<'product_attributes'> | null, value: AttributeValue | null): boolean {
	if (!row || !value) return row === value;
	const eq = (a: string | null, b: string | null) => a === null || b === null ? a === b : compareDecimals(a, b) === 0;
	return eq(row.number_value, value.number_value) && eq(row.number_max, value.number_max) && row.text_value === value.text_value && row.boolean_value === value.boolean_value;
}
async function checkAttribute(ctx: QueryCtx, value: AttributeValue) {
	const definition = (await byUuid(ctx, 'attribute_definitions', value.attribute_id)) ?? fail('INVALID_ATTRIBUTE', 'attribute_id');
	const present = [value.number_value, value.text_value, value.boolean_value].filter((x) => x !== null).length;
	if (present !== 1) fail('INVALID_ATTRIBUTE');
	if ((definition.value_type === 'number' && value.number_value === null) || (definition.value_type === 'text' && value.text_value === null)
		|| (definition.value_type === 'boolean' && value.boolean_value === null)) fail('ATTRIBUTE_VALUE_TYPE_MISMATCH');
	if (value.number_value !== null && !isDecimal(value.number_value)) fail('INVALID_ATTRIBUTE');
	if (value.number_max !== null && (value.number_value === null || !isDecimal(value.number_max) || compareDecimals(value.number_max, value.number_value) <= 0)) fail('INVALID_ATTRIBUTE');
	if (value.text_value !== null && [...value.text_value].length > 2000) fail('INVALID_ATTRIBUTE');
}

/** Set one specification from `before` to `after` (null: absent). Returns false when it already differs from both. */
async function applyAttribute(ctx: MutationCtx, actor: Actor, productId: string, before: AttributeValue | null, after: AttributeValue | null): Promise<boolean> {
	const attributeId = (after ?? before)!.attribute_id;
	const current = await ctx.db.query('product_attributes').withIndex('product_attribute', (q) => q.eq('product_id', productId).eq('attribute_id', attributeId)).unique();
	if (sameAttribute(current, after)) return true;
	if (!sameAttribute(current, before)) return false;
	if (!after) { await deleteAudited(ctx, actor, current!); return true; }
	await ensureDefinition(ctx, actor, after.attribute_id);
	await checkAttribute(ctx, after);
	const values = { number_value: after.number_value, number_max: after.number_max, text_value: after.text_value, boolean_value: after.boolean_value };
	if (current) await patchAudited(ctx, actor, 'product_attributes', current, values);
	else await insertAudited(ctx, actor, 'product_attributes', { product_id: productId, attribute_id: after.attribute_id, ...values });
	return true;
}

/**
 * Create (revision null) or edit a product, with optional specification changes,
 * atomically. A retry of a command that already applied returns the product.
 */
export const save = mutation({
	args: { payload: productPayload, revision: v.union(v.string(), v.null()), attributes: v.optional(v.array(attributeValue)), attributeBefore: v.optional(v.array(attributeValue)) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const p = args.payload;
		let product = await byUuid(ctx, 'products', p.id);
		const decimals = new Set(['stock_step', 'sale_step', 'minimum_stock', 'sale_unit_price_nok']);
		const matches = product !== null && (Object.keys(p) as (keyof ProductPayload)[]).every((key) => {
			const a = product![key], b = p[key];
			return decimals.has(key) && typeof a === 'string' && typeof b === 'string' && isDecimal(b) ? compareDecimals(a, b) === 0 : a === b;
		});
		if (!matches) {
			if ((args.revision === null) !== (product === null) || (product && String(product.metadata_revision) !== args.revision)) fail('STALE_PRODUCT');
			await ensureCategory(ctx, actor, p.category_id);
			await checkProduct(ctx, p);
			const now = isoNow();
			if (!product) {
				if (await ctx.db.query('products').withIndex('code', (q) => q.eq('code', p.code)).unique()) fail('PRODUCT_CODE_TAKEN');
				product = await insertAudited(ctx, actor, 'products', { ...p, metadata_revision: 1, created_at: now, updated_at: now });
			} else {
				if (p.code !== product.code || p.unit_code !== product.unit_code || compareDecimals(p.stock_step, product.stock_step) !== 0) fail('PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE');
				const { id, code, unit_code, stock_step, ...editable } = p;
				product = await patchAudited(ctx, actor, 'products', product, { ...editable, metadata_revision: product.metadata_revision + 1, updated_at: now });
			}
		}
		const after = args.attributes ?? [], before = args.attributeBefore ?? [];
		if (new Set(after.map((a) => a.attribute_id)).size !== after.length) fail('DUPLICATE_PRODUCT_SPECIFICATION');
		for (const value of after) {
			if (!await applyAttribute(ctx, actor, product!.id, before.find((b) => b.attribute_id === value.attribute_id) ?? null, value)) fail('STALE_PRODUCT');
		}
		for (const previous of before) {
			if (!after.some((a) => a.attribute_id === previous.attribute_id) && !await applyAttribute(ctx, actor, product!.id, previous, null)) fail('STALE_PRODUCT');
		}
		return productRow(product!);
	}
});

/**
 * Set one specification of a saved product from the value the editor showed
 * (`before`, null: absent) to `after` (null: remove). A retry of a change that
 * already applied succeeds without writing again.
 */
export const setAttribute = mutation({
	args: { productId: v.string(), before: v.union(attributeValue, v.null()), after: v.union(attributeValue, v.null()) },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		if (!args.before && !args.after) fail('INVALID_ATTRIBUTE');
		if (args.before && args.after && args.before.attribute_id !== args.after.attribute_id) fail('INVALID_ATTRIBUTE');
		if (!await byUuid(ctx, 'products', args.productId)) fail('PRODUCT_NOT_FOUND', args.productId);
		if (!await applyAttribute(ctx, actor, args.productId, args.before, args.after)) fail('STALE_PRODUCT');
		return 'saved' as const;
	}
});

/** Rename a category or relabel a specification; `before` is the value the editor showed. */
export const rename = mutation({
	args: { kind: v.union(v.literal('category'), v.literal('definition')), id: v.string(), before: v.string(), after: v.string() },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		if (args.kind === 'category') {
			const row = (await byUuid(ctx, 'categories', args.id)) ?? fail('STALE_PRODUCT');
			if (row.name === args.after) return 'saved' as const;
			if (row.name !== args.before) fail('STALE_PRODUCT');
			if (!textBetween(args.after, 1, 100)) fail('INVALID_CATEGORY');
			if (await ctx.db.query('categories').withIndex('name', (q) => q.eq('name', args.after)).unique()) fail('CATEGORY_NAME_TAKEN');
			await patchAudited(ctx, actor, 'categories', row, { name: args.after });
		} else {
			const row = (await byUuid(ctx, 'attribute_definitions', args.id)) ?? fail('STALE_PRODUCT');
			if (row.label === args.after) return 'saved' as const;
			if (row.label !== args.before) fail('STALE_PRODUCT');
			if (!textBetween(args.after, 1, 100)) fail('INVALID_DEFINITION');
			await patchAudited(ctx, actor, 'attribute_definitions', row, { label: args.after });
		}
		return 'saved' as const;
	}
});

/** A new custom specification type. Its meaning (code, type, unit) never changes afterwards. */
export const createDefinition = mutation({
	args: { id: v.string(), code: v.string(), label: v.string(), value_type: v.union(v.literal('number'), v.literal('text'), v.literal('boolean')), canonical_unit: nullableString },
	handler: async (ctx, args) => {
		const { actor } = await requireStaff(ctx);
		const existing = await byUuid(ctx, 'attribute_definitions', args.id);
		if (existing) {
			if (existing.code !== args.code || existing.value_type !== args.value_type || existing.canonical_unit !== args.canonical_unit) fail('DEFINITION_ID_TAKEN');
			return existing.id;
		}
		if (!isUuid(args.id) || !/^[a-z][a-z0-9_]{0,63}$/.test(args.code) || !textBetween(args.label, 1, 100)
			|| (args.canonical_unit !== null && args.value_type !== 'number')) fail('INVALID_DEFINITION');
		if (await ctx.db.query('attribute_definitions').withIndex('code', (q) => q.eq('code', args.code)).unique()) fail('DEFINITION_CODE_TAKEN');
		await insertAudited(ctx, actor, 'attribute_definitions', args);
		return args.id;
	}
});

// ---------- Staff reads ----------

export const list = query({
	args: { ids: v.optional(v.array(v.string())) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const rows = args.ids ? (await Promise.all(args.ids.map((id) => byUuid(ctx, 'products', id)))).filter((p) => p !== null) : await ctx.db.query('products').collect();
		return rows.map(productRow);
	}
});

export const get = query({
	args: { id: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const product = await byUuid(ctx, 'products', args.id);
		return product ? productRow(product) : null;
	}
});

/** Every product (published or not) created after `since`, for the new-products review. */
export const createdSince = query({
	args: { since: v.string() },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const since = new Date(Date.parse(args.since)).toISOString().replace(/Z$/, '000Z');
		return (await ctx.db.query('products').withIndex('created_at', (q) => q.gt('created_at', since)).collect()).map(productRow);
	}
});

export const references = query({
	args: {},
	handler: async (ctx) => {
		await requireStaff(ctx);
		return {
			categories: (await ctx.db.query('categories').collect()).map((c) => ({ id: c.id, name: c.name })),
			definitions: (await ctx.db.query('attribute_definitions').collect()).map((d) => ({ id: d.id, code: d.code, label: d.label, value_type: d.value_type, canonical_unit: d.canonical_unit })),
			units: (await ctx.db.query('units').collect()).sort((a, b) => a.code.localeCompare(b.code)).map((u) => ({ code: u.code, name: u.name, symbol: u.symbol, is_discrete: u.is_discrete }))
		};
	}
});

/** One product's specification values, or all of them (labels, staff search). */
export const attributes = query({
	args: { productId: v.optional(v.string()) },
	handler: async (ctx, args) => {
		await requireStaff(ctx);
		const rows = args.productId === undefined ? await ctx.db.query('product_attributes').collect()
			: await ctx.db.query('product_attributes').withIndex('product_attribute', (q) => q.eq('product_id', args.productId!)).collect();
		return rows.map(attributeRow).sort((a, b) => a.product_id.localeCompare(b.product_id) || a.attribute_id.localeCompare(b.attribute_id));
	}
});
