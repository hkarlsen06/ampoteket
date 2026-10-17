import { api, errorCode, type StaffSession } from './convex';
import type { FunctionReturnType } from 'convex/server';
import { compareDecimals, multiplyDecimals, normalizeDecimal, validQuantity } from './decimal';
import { identifier, object, text } from './api';
import type { ShelfTopology } from './shelf-map';
import { productFamilies, productTypes, type ProductFamily } from './product-specifications';
export { productFamilies, productTypes, type ProductFamily } from './product-specifications';
import { catalogSearchText } from './catalog-search';
import type { CatalogAttribute } from './catalog';

export type ProductWrite = { id: string; code: string; name_nb: string; name_en: string; description: string | null; category_id: string | null; bin_id: string | null; location_note: string | null; unit_code: string; stock_step: string; sale_step: string; sale_unit_price_nok: string | null; minimum_stock: string; datasheet_url: string | null; purchase_url: string | null; is_active: boolean };
export type AdminProduct = ProductWrite & { metadata_revision: string };
export type Category = { id: string; name: string };
import type { AttributeDefinition } from './catalog-types';
export type { AttributeDefinition } from './catalog-types';
/** A number may be a range: number_value is then its lower bound and number_max the upper one. */
export type AttributeValue = { product_id: string; attribute_id: string; number_value: string | null; number_max: string | null; text_value: string | null; boolean_value: boolean | null };
export type ProductReferences = { categories: Category[]; definitions: AttributeDefinition[]; units: { code: string; name: string; symbol: string; is_discrete: boolean }[]; shelf: ShelfTopology };
export type ProductStock = { product_id: string; quantity: string; revision: string; last_counted_at: string | null };
export function productCategoryOptions(categories: Category[]) {
	return productTypes.map(type => ({ ...type, id: categories.find(category => category.name === type.name)?.id ?? type.id }));
}
export function generateCategoryProductCode(categoryId: string | null, categories: Category[], previousCode?: string): string {
	const type = productCategoryOptions(categories).find(type => type.id === categoryId);
	if (!type) throw new Error('Choose a standard category');
	// After a definite rejected creation, retain its candidate only while the
	// chosen category still matches. Uncertain retries use the frozen command.
	if (previousCode?.startsWith(`${type.prefix}-`) && /^[A-Z]{3}-[A-F0-9]{5}$/.test(previousCode)) return previousCode;
	return generateProductCode(type.prefix);
}
const codePattern = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const unitPattern = /^[a-z][a-z0-9_]{0,23}$/;
function nullableText(value: unknown): string | null { if (value !== null && typeof value !== 'string') throw new Error('Invalid text'); return value; }
function webLink(value: unknown): string | null {
	const link = nullableText(value);
	if (link) {
		const url = new URL(link);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(link)) throw new Error();
	}
	return link;
}
export function exactNumber(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2000 || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid exact number');
	return normalizeDecimal(value);
}
function boundedDecimal(value: unknown): string {
	const n = exactNumber(value);
	if ((n.split('.')[1]?.length ?? 0) > 6 || compareDecimals(n, '0') < 0 || compareDecimals(n, '999999999999') > 0) throw new Error('Invalid product decimal');
	return n;
}
export class ProductFieldError extends Error {
	constructor(readonly field: keyof ProductWrite) { super(`Invalid product field: ${field}`); }
}
export function parseProductWrite(value: unknown): ProductWrite {
	const r = object(value);
	let field: keyof ProductWrite = 'code';
	try {
		const code = text(r.code, 40);
		if (!codePattern.test(code)) throw new Error();
		field = 'unit_code';
		const unit_code = text(r.unit_code, 24);
		if (!unitPattern.test(unit_code)) throw new Error();
		field = 'stock_step';
		const stock_step = boundedDecimal(r.stock_step);
		if (compareDecimals(stock_step, '0') <= 0 || (unit_code === 'pcs' && stock_step.includes('.'))) throw new Error();
		field = 'sale_step';
		const sale_step = validQuantity(boundedDecimal(r.sale_step), stock_step);
		if (unit_code === 'pcs' && sale_step.includes('.')) throw new Error();
		field = 'minimum_stock';
		const minimum_stock = boundedDecimal(r.minimum_stock);
		if (minimum_stock !== '0') validQuantity(minimum_stock, stock_step);
		field = 'is_active';
		if (typeof r.is_active !== 'boolean') throw new Error();
		field = 'bin_id';
		const bin_id = r.bin_id === null ? null : identifier(r.bin_id);
		field = 'location_note';
		// Drafts saved before this field existed have no key. A drawer replaces the note.
		const location_note = r.location_note == null ? null : text(r.location_note, 200);
		if (bin_id && location_note) throw new Error();
		field = 'datasheet_url';
		const datasheet_url = webLink(r.datasheet_url);
		field = 'purchase_url';
		// Drafts saved before this field existed have no key.
		const purchase_url = webLink(r.purchase_url ?? null);
		field = 'sale_unit_price_nok';
		// Null: borrow-only, listed with stock but never sold.
		const sale_unit_price_nok = r.sale_unit_price_nok === null ? null : boundedDecimal(r.sale_unit_price_nok);
		field = 'name_nb';
		const name_nb = text(r.name_nb, 200);
		field = 'name_en';
		const name_en = text(r.name_en, 200);
		field = 'description';
		const description = nullableText(r.description);
		field = 'category_id';
		const category_id = r.category_id === null ? null : identifier(r.category_id);
		field = 'id';
		return { id: identifier(r.id), code, unit_code, stock_step, sale_step, sale_unit_price_nok, minimum_stock, name_nb, name_en, description, category_id, bin_id, location_note, datasheet_url, purchase_url, is_active: r.is_active };
	} catch { throw new ProductFieldError(field); }
}
export function parseAdminProduct(value: unknown): AdminProduct {
	const r = object(value);
	if (typeof r.metadata_revision !== 'string' || !/^[1-9]\d*$/.test(r.metadata_revision)) throw new Error('Invalid metadata revision');
	return { ...parseProductWrite(r), metadata_revision: r.metadata_revision };
}
export function parseCategory(value: unknown): Category { const r = object(value); return { id: identifier(r.id), name: text(r.name, 100) }; }
export function parseDefinition(value: unknown): AttributeDefinition {
	const r = object(value); const code = text(r.code, 64);
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !['number', 'text', 'boolean'].includes(String(r.value_type))) throw new Error('Invalid definition');
	const canonical_unit = nullableText(r.canonical_unit);
	if (canonical_unit !== null && r.value_type !== 'number') throw new Error('Invalid attribute unit');
	return { id: identifier(r.id), code, label: text(r.label, 100), value_type: r.value_type as AttributeDefinition['value_type'], canonical_unit };
}
export function parseAttribute(value: unknown): AttributeValue {
	const r = object(value); const number_value = r.number_value === null ? null : exactNumber(r.number_value); const text_value = nullableText(r.text_value);
	// Commands saved before ranges existed have no number_max: a single value.
	const number_max = r.number_max === undefined || r.number_max === null ? null : exactNumber(r.number_max);
	if ((r.boolean_value !== null && typeof r.boolean_value !== 'boolean') || (text_value !== null && [...text_value].length > 2000)
		|| [number_value, text_value, r.boolean_value].filter(v => v !== null).length !== 1
		|| (number_max !== null && (number_value === null || compareDecimals(number_max, number_value) <= 0))) throw new Error('Invalid attribute');
	return { product_id: identifier(r.product_id), attribute_id: identifier(r.attribute_id), number_value, number_max, text_value, boolean_value: r.boolean_value as boolean | null };
}
export function parseStock(value: unknown): ProductStock {
	const r = object(value); const quantity = exactNumber(r.quantity);
	if ((quantity.split('.')[1]?.length ?? 0) > 6 || typeof r.revision !== 'string' || !/^\d+$/.test(r.revision)
		|| (r.last_counted_at !== null && (typeof r.last_counted_at !== 'string' || !Number.isFinite(Date.parse(r.last_counted_at))))) throw new Error('Invalid stock');
	return { product_id: identifier(r.product_id), quantity, revision: r.revision, last_counted_at: r.last_counted_at as string | null };
}
/** `stock.inventory` rows carry the revision as a number; the client keeps it a string. */
export function inventoryStock(rows: { product_id: string; quantity: string; revision: number; last_counted_at: string | null }[]): ProductStock[] {
	return rows.map(row => parseStock({ ...row, revision: String(row.revision) }));
}
export async function readAdminProducts(session: StaffSession, ids?: string[]): Promise<AdminProduct[]> {
	return (await session.client.query(api.products.list, ids ? { ids: ids.map(identifier) } : {})).map(parseAdminProduct);
}
export async function readProduct(session: StaffSession, id: string): Promise<AdminProduct | null> {
	const raw = await session.client.query(api.products.get, { id: identifier(id) });
	const product = raw ? parseAdminProduct(raw) : null;
	if (product && product.id !== id) throw new Error('Invalid product binding');
	return product;
}
export async function readProductStock(session: StaffSession, id: string): Promise<ProductStock> {
	const rows = inventoryStock(await session.client.query(api.stock.inventory, { productIds: [identifier(id)] }));
	if (rows.length !== 1 || rows[0].product_id !== id) throw new Error('Invalid inventory binding');
	return rows[0];
}
// Matches the admin overview: active sold out, active below minimum, other active, then
// inactive. Unknown stock is never sold out.
export function stockRank(product: Pick<AdminProduct, 'is_active' | 'minimum_stock'>, quantity: string | undefined): 0 | 1 | 2 | 3 {
	if (!product.is_active) return 3;
	if (quantity === undefined) return 2;
	return compareDecimals(quantity, '0') <= 0 ? 0 : compareDecimals(quantity, product.minimum_stock) < 0 ? 1 : 2;
}
// Below-minimum products sort by lowest share of their minimum; units never compare directly.
export function compareAttention(a: Pick<AdminProduct, 'is_active' | 'minimum_stock'>, aQuantity: string | undefined, b: Pick<AdminProduct, 'is_active' | 'minimum_stock'>, bQuantity: string | undefined): number {
	const rank = stockRank(a, aQuantity);
	return rank - stockRank(b, bQuantity)
		|| (rank === 1 ? compareDecimals(multiplyDecimals(aQuantity!, b.minimum_stock), multiplyDecimals(bQuantity!, a.minimum_stock)) : 0);
}
export async function readInventory(session: StaffSession): Promise<ProductStock[]> {
	return inventoryStock(await session.client.query(api.stock.inventory, {}));
}
/** One product's specification values, or with no ID every product's (labels, staff search). */
export function productAttributes(rows: unknown[], productId?: string): AttributeValue[] {
	return rows.map(value => {
		const row = parseAttribute(value);
		if (productId !== undefined && row.product_id !== productId) throw new Error('Invalid attribute binding');
		return row;
	});
}
export async function readProductAttributes(session: StaffSession, id: string): Promise<AttributeValue[]> {
	return productAttributes(await session.client.query(api.products.attributes, { productId: identifier(id) }), id);
}
export async function readAllProductAttributes(session: StaffSession): Promise<AttributeValue[]> {
	return productAttributes(await session.client.query(api.products.attributes, {}));
}
/** Categories, specification types and units (`products.references`) with the live wall (`catalog.shelfMap`). */
export function productReferences(raw: FunctionReturnType<typeof api.products.references>, shelf: ShelfTopology): ProductReferences {
	const units = raw.units.map(unit => {
		if (!unitPattern.test(unit.code)) throw new Error('Invalid unit');
		return { code: unit.code, name: text(unit.name, 200), symbol: text(unit.symbol, 100), is_discrete: unit.is_discrete };
	});
	return { categories: raw.categories.map(parseCategory), definitions: raw.definitions.map(parseDefinition), units, shelf };
}
export async function readProductReferences(session: StaffSession): Promise<ProductReferences> {
	const [raw, shelf] = await Promise.all([session.client.query(api.products.references, {}), session.client.query(api.catalog.shelfMap, {})]);
	return productReferences(raw, shelf);
}
export function generateProductCode(family: ProductFamily, cryptoSource: Pick<Crypto, 'getRandomValues'> = crypto): string {
	if (!productFamilies.includes(family)) throw new Error('Invalid product family');
	const bytes = cryptoSource.getRandomValues(new Uint8Array(3)); return `${family}-${Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('').slice(0, 5).toUpperCase()}`;
}
export type ProductAttributeDraft = Omit<AttributeValue, 'product_id'>;
// `opening` is a new product's first count, posted once the creation is acknowledged.
export type ProductCommand = { userId: string; payload: ProductWrite; revision: string | null; attributes?: ProductAttributeDraft[]; opening?: string };
function commandAttributes(command: ProductCommand): ProductAttributeDraft[] | undefined {
	if (command.attributes === undefined) return undefined;
	if (command.revision !== null || !Array.isArray(command.attributes)) throw new Error('Invalid product specifications');
	const rows = command.attributes.map(value => {
		const { product_id, ...draft } = parseAttribute({ ...value, product_id: command.payload.id });
		return draft;
	});
	if (new Set(rows.map(row => row.attribute_id)).size !== rows.length) throw new Error('Duplicate product specification');
	return rows;
}
export const productCommandKey = 'ampoteket:admin-product:v1';
export function readProductCommand(storage: Pick<Storage, 'getItem'>): ProductCommand | null {
	const raw = storage.getItem(productCommandKey); if (!raw) return null; const c = object(JSON.parse(raw));
	if (c.revision !== null && (typeof c.revision !== 'string' || !/^[1-9]\d*$/.test(c.revision))) throw new Error('Invalid command revision');
	const command: ProductCommand = { userId: identifier(c.userId), payload: parseProductWrite(c.payload), revision: c.revision as string | null };
	if ('attributes' in c) command.attributes = commandAttributes({ ...command, attributes: c.attributes as ProductAttributeDraft[] });
	if ('opening' in c) {
		if (command.revision !== null || typeof c.opening !== 'string' || !/^\d+(\.\d+)?$/.test(c.opening)) throw new Error('Invalid opening stock');
		command.opening = c.opening;
	}
	return command;
}
export function persistProductCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: ProductCommand): void {
	const previous = readProductCommand(storage);
	if (previous && !sameCommand(previous, command)) throw new Error('Unresolved product command');
	const serialized = JSON.stringify({ ...command, payload: parseProductWrite(command.payload), ...(command.attributes === undefined ? {} : { attributes: commandAttributes(command) }) }); storage.setItem(productCommandKey, serialized);
	if (storage.getItem(productCommandKey) !== serialized) throw new Error('Product persistence unavailable');
}
export function clearProductCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: ProductCommand): void {
	const current = readProductCommand(storage); if (current && sameCommand(current, command)) storage.removeItem(productCommandKey);
}
function sameCommand(a: ProductCommand, b: ProductCommand): boolean { return a.userId === b.userId && a.revision === b.revision && JSON.stringify(parseProductWrite(a.payload)) === JSON.stringify(parseProductWrite(b.payload)) && JSON.stringify(commandAttributes(a)) === JSON.stringify(commandAttributes(b)) && a.opening === b.opening; }
export class StaleProductError extends Error {}
export function sameProduct(product: AdminProduct, payload: ProductWrite): boolean { return (Object.keys(payload) as (keyof ProductWrite)[]).every(key => product[key] === payload[key]); }
/**
 * One transaction (`products.save`): a standard category on first use, the
 * product, and a new product's specifications. A retry of a command that
 * already applied returns the product without writing again.
 */
export async function executeProductCommand(session: StaffSession, command: ProductCommand): Promise<AdminProduct> {
	if (session.userId !== command.userId) throw new Error('Product identity changed');
	const payload = parseProductWrite(command.payload); const attributes = commandAttributes(command);
	let raw: unknown;
	try {
		raw = await session.client.mutation(api.products.save, { payload, revision: command.revision, ...(attributes ? { attributes } : {}) });
	} catch (error) {
		if (errorCode(error) !== 'STALE_PRODUCT') throw error;
		// A creation's ID is minted for that command alone and applies whole or not at
		// all, so an existing product means this creation saved and was edited since.
		const created = command.revision === null ? await readProduct(session, payload.id) : null;
		if (created) return created;
		throw new StaleProductError();
	}
	const result = parseAdminProduct(raw);
	if (!sameProduct(result, payload)) throw new Error('Product write differs');
	return result;
}
export function isProductCodeCollision(error: unknown): boolean { return errorCode(error) === 'PRODUCT_CODE_TAKEN'; }
/** The backend rejected the command, so nothing changed. Lost access keeps it for a retry once restored. */
export function definitiveProductFailure(error: unknown): boolean {
	const code = errorCode(error);
	return code !== null && code !== 'STAFF_REQUIRED';
}

/** These independent metadata edits use the shown value as a compare-and-set guard.
 * An unknown response is resolved by sending the same command again. */
export type DetailCommand = { userId: string; kind: 'category' | 'definition' | 'attribute'; before: Category | AttributeDefinition | AttributeValue | null; after: Category | AttributeDefinition | AttributeValue | null };
export const detailCommandKey = 'ampoteket:admin-product-detail:v1';
export function parseDetailCommand(value: unknown): DetailCommand {
	const r = object(value); if (!['category', 'definition', 'attribute'].includes(String(r.kind))) throw new Error('Invalid detail command');
	const parse = r.kind === 'category' ? parseCategory : r.kind === 'definition' ? parseDefinition : parseAttribute;
	const before = r.before === null ? null : parse(r.before); const after = r.after === null ? null : parse(r.after);
	if ((!before && !after) || (!after && r.kind !== 'attribute')) throw new Error('Invalid metadata operation');
	if (before && after && detailIdentity(before) !== detailIdentity(after)) throw new Error('Metadata identity changed');
	return { userId: identifier(r.userId), kind: r.kind as DetailCommand['kind'], before, after };
}
function detailIdentity(value: NonNullable<DetailCommand['before']>): string { return 'id' in value ? value.id : `${value.product_id}:${value.attribute_id}`; }
function attributeDraft(value: AttributeValue | null): ProductAttributeDraft | null {
	if (!value) return null;
	const { product_id, ...draft } = value;
	return draft;
}
async function sendDetailCommand(session: StaffSession, c: DetailCommand): Promise<void> {
	if (c.kind === 'attribute') {
		const subject = (c.after ?? c.before) as AttributeValue;
		await session.client.mutation(api.products.setAttribute, { productId: subject.product_id, before: attributeDraft(c.before as AttributeValue | null), after: attributeDraft(c.after as AttributeValue | null) });
	} else if (c.kind === 'definition' && !c.before) {
		const { id, code, label, value_type, canonical_unit } = c.after as AttributeDefinition;
		await session.client.mutation(api.products.createDefinition, { id, code, label, value_type, canonical_unit });
	} else if (c.kind === 'definition') {
		await session.client.mutation(api.products.rename, { kind: 'definition', id: (c.after as AttributeDefinition).id, before: (c.before as AttributeDefinition).label, after: (c.after as AttributeDefinition).label });
	} else if (c.before) {
		await session.client.mutation(api.products.rename, { kind: 'category', id: (c.after as Category).id, before: (c.before as Category).name, after: (c.after as Category).name });
	} else {
		// Custom categories are no longer created. A creation saved before then
		// finishes only if it already applied; otherwise it is not repeated.
		const category = c.after as Category;
		const { categories } = await session.client.query(api.products.references, {});
		if (!categories.some(row => row.id === category.id && row.name === category.name)) throw new StaleProductError();
	}
}
export async function executeDetailCommand(session: StaffSession, command: DetailCommand): Promise<void> {
	if (session.userId !== command.userId) throw new Error('Detail identity changed');
	try { await sendDetailCommand(session, parseDetailCommand(command)); }
	catch (error) { throw errorCode(error) === 'STALE_PRODUCT' ? new StaleProductError() : error; }
}
/** Staff search reads the same fields as the shop catalog, unpublished products included. */
export function adminSearchTexts(products: AdminProduct[], references: ProductReferences, values: AttributeValue[]): Map<string, string> {
	const categories = new Map(references.categories.map(category => [category.id, category.name]));
	const definitions = new Map(references.definitions.map(definition => [definition.id, definition]));
	const attributes = new Map<string, Record<string, CatalogAttribute>>();
	for (const value of values) {
		const d = definitions.get(value.attribute_id); if (!d) continue;
		const attribute = (d.value_type === 'number' ? { label: d.label, unit: d.canonical_unit, value_type: 'number', value: value.number_value, max: value.number_max }
			: d.value_type === 'text' ? { label: d.label, unit: null, value_type: 'text', value: value.text_value }
			: { label: d.label, unit: null, value_type: 'boolean', value: value.boolean_value }) as CatalogAttribute;
		if (attribute.value === null) continue;
		attributes.set(value.product_id, { ...attributes.get(value.product_id), [d.code]: attribute });
	}
	return new Map(products.map(p => [p.id, catalogSearchText({ ...p, category_name: p.category_id === null ? null : categories.get(p.category_id) ?? null, attributes: attributes.get(p.id) ?? {} })]));
}
