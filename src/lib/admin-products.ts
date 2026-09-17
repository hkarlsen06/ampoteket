import { ApiError } from './api';
import { allStaffRows, staffEquals, staffRequest, type StaffSession } from './admin-api';
import { compareDecimals, multiplyDecimals, normalizeDecimal, validQuantity } from './decimal';
import { identifier, object, text, type Fetcher } from './api';
import { readShelfTopology, type ShelfTopology } from './shelf-map';
import { standardSpecifications } from './product-specifications';

export const productSelect = 'id,code,name_nb,name_en,description,category_id,bin_id,location_note,unit_code,stock_step,sale_step,sale_unit_price_nok,minimum_stock,datasheet_url,purchase_url,is_active,metadata_revision';
export type ProductWrite = { id: string; code: string; name_nb: string; name_en: string; description: string | null; category_id: string | null; bin_id: string | null; location_note: string | null; unit_code: string; stock_step: string; sale_step: string; sale_unit_price_nok: string; minimum_stock: string; datasheet_url: string | null; purchase_url: string | null; is_active: boolean };
export type AdminProduct = ProductWrite & { metadata_revision: string };
export type Category = { id: string; name: string };
export type AttributeDefinition = { id: string; code: string; label: string; value_type: 'number' | 'text' | 'boolean'; canonical_unit: string | null };
export type AttributeValue = { product_id: string; attribute_id: string; number_value: string | null; text_value: string | null; boolean_value: boolean | null };
export type ProductReferences = { categories: Category[]; definitions: AttributeDefinition[]; units: { code: string; name: string; symbol: string; is_discrete: boolean }[]; shelf: ShelfTopology };
export type ProductStock = { product_id: string; quantity: string; revision: string; last_counted_at: string | null };
// Stable identities for categories first created through the standard picker.
// Never change an ID when reordering or translating the choices.
export const productTypes = [
	{ prefix: 'RES', name: 'Resistors', id: '824dd61f-6781-49ae-8000-000000000001' },
	{ prefix: 'CAP', name: 'Capacitors', id: '824dd61f-6781-49ae-8000-000000000002' },
	{ prefix: 'DIO', name: 'Diodes', id: '824dd61f-6781-49ae-8000-000000000003' },
	{ prefix: 'LED', name: 'LEDs', id: '824dd61f-6781-49ae-8000-000000000004' },
	{ prefix: 'BJT', name: 'Bipolar transistors', id: '824dd61f-6781-49ae-8000-000000000005' },
	{ prefix: 'MOS', name: 'MOSFETs', id: '824dd61f-6781-49ae-8000-000000000006' },
	{ prefix: 'MCU', name: 'Controllers', id: '824dd61f-6781-49ae-8000-000000000007' },
	{ prefix: 'SEN', name: 'Sensors', id: '824dd61f-6781-49ae-8000-000000000008' },
	{ prefix: 'MOT', name: 'Motors', id: '824dd61f-6781-49ae-8000-000000000009' },
	{ prefix: 'DRV', name: 'Motor drivers', id: '824dd61f-6781-49ae-8000-00000000000a' },
	{ prefix: 'CON', name: 'Connectors', id: '824dd61f-6781-49ae-8000-00000000000b' },
	{ prefix: 'BRD', name: 'Prototyping', id: '824dd61f-6781-49ae-8000-00000000000c' },
	{ prefix: 'CAB', name: 'Cable', id: '824dd61f-6781-49ae-8000-00000000000d' },
	{ prefix: 'MIS', name: 'Miscellaneous', id: '824dd61f-6781-49ae-8000-00000000000e' }
] as const;
export const productFamilies = productTypes.map(type => type.prefix);
export type ProductFamily = typeof productFamilies[number];
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
		const sale_unit_price_nok = boundedDecimal(r.sale_unit_price_nok);
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
	if ((r.boolean_value !== null && typeof r.boolean_value !== 'boolean') || (text_value !== null && [...text_value].length > 2000)
		|| [number_value, text_value, r.boolean_value].filter(v => v !== null).length !== 1) throw new Error('Invalid attribute');
	return { product_id: identifier(r.product_id), attribute_id: identifier(r.attribute_id), number_value, text_value, boolean_value: r.boolean_value as boolean | null };
}
export function parseStock(value: unknown): ProductStock {
	const r = object(value); const quantity = exactNumber(r.quantity);
	if ((quantity.split('.')[1]?.length ?? 0) > 6 || typeof r.revision !== 'string' || !/^\d+$/.test(r.revision)
		|| (r.last_counted_at !== null && (typeof r.last_counted_at !== 'string' || !Number.isFinite(Date.parse(r.last_counted_at))))) throw new Error('Invalid stock');
	return { product_id: identifier(r.product_id), quantity, revision: r.revision, last_counted_at: r.last_counted_at as string | null };
}
export async function readAdminProducts(session: StaffSession, fetcher: Fetcher = fetch, ids?: string[]): Promise<AdminProduct[]> {
	return (await allStaffRows(session, 'amp_products', productSelect, 'id', ids ? { id: `in.(${ids.map(identifier).join(',')})` } : {}, fetcher)).map(parseAdminProduct);
}
export async function readProduct(session: StaffSession, id: string, fetcher: Fetcher = fetch): Promise<AdminProduct | null> {
	identifier(id); const raw = await staffRequest(session, 'amp_products', { select: productSelect, id: `eq.${id}`, limit: '2' }, undefined, 'POST', fetcher);
	if (!Array.isArray(raw) || raw.length > 1) throw new Error('Invalid product lookup');
	const product = raw.length ? parseAdminProduct(raw[0]) : null;
	if (product && product.id !== id) throw new Error('Invalid product binding');
	return product;
}
export async function readProductStock(session: StaffSession, id: string, fetcher: Fetcher = fetch): Promise<ProductStock> {
	identifier(id); const raw = await staffRequest(session, 'amp_inventory', { select: 'product_id,quantity,revision,last_counted_at', product_id: `eq.${id}`, limit: '2' }, undefined, 'POST', fetcher);
	if (!Array.isArray(raw) || raw.length !== 1) throw new Error('Missing inventory');
	const stock = parseStock(raw[0]); if (stock.product_id !== id) throw new Error('Invalid inventory binding'); return stock;
}
// Matches the admin overview: active sold out, active below minimum, other active, then
// inactive. Unknown stock is never sold out.
export function stockRank(product: AdminProduct, quantity: string | undefined): 0 | 1 | 2 | 3 {
	if (!product.is_active) return 3;
	if (quantity === undefined) return 2;
	return compareDecimals(quantity, '0') <= 0 ? 0 : compareDecimals(quantity, product.minimum_stock) < 0 ? 1 : 2;
}
// Below-minimum products sort by lowest share of their minimum; units never compare directly.
export function compareAttention(a: AdminProduct, aQuantity: string | undefined, b: AdminProduct, bQuantity: string | undefined): number {
	const rank = stockRank(a, aQuantity);
	return rank - stockRank(b, bQuantity)
		|| (rank === 1 ? compareDecimals(multiplyDecimals(aQuantity!, b.minimum_stock), multiplyDecimals(bQuantity!, a.minimum_stock)) : 0);
}
export async function readInventory(session: StaffSession, fetcher: Fetcher = fetch): Promise<ProductStock[]> {
	return (await allStaffRows(session, 'amp_inventory', 'product_id,quantity,revision,last_counted_at', 'product_id', {}, fetcher)).map(parseStock);
}
export async function readProductAttributes(session: StaffSession, id: string, fetcher: Fetcher = fetch): Promise<AttributeValue[]> {
	identifier(id);
	return (await allStaffRows(session, 'amp_product_attributes', 'product_id,attribute_id,number_value,text_value,boolean_value', 'attribute_id', { product_id: `eq.${id}` }, fetcher)).map(value => { const v = parseAttribute(value); if (v.product_id !== id) throw new Error('Invalid attribute binding'); return v; });
}
export async function readProductReferences(session: StaffSession, fetcher: Fetcher = fetch): Promise<ProductReferences> {
	const [categories, definitions, shelf] = await Promise.all([
		allStaffRows(session, 'amp_categories', 'id,name', 'id', {}, fetcher),
		allStaffRows(session, 'amp_attribute_definitions', 'id,code,label,value_type,canonical_unit', 'id', {}, fetcher),
		readShelfTopology(session.config, { fetcher })
	]);
	const units: ProductReferences['units'] = []; let after = '';
	for (;;) {
		const page = await staffRequest(session, 'amp_units', { select: 'code,name,symbol,is_discrete', order: 'code.asc', limit: '200', ...(after ? { code: `gt.${after}` } : {}) }, undefined, 'POST', fetcher);
		if (!Array.isArray(page) || page.length > 200) throw new Error('Invalid units');
		if (!page.length) break;
		for (const value of page) { const r = object(value); const code = text(r.code, 24); if (!unitPattern.test(code) || code <= after || typeof r.is_discrete !== 'boolean') throw new Error('Invalid unit cursor'); units.push({ code, name: text(r.name, 200), symbol: text(r.symbol, 100), is_discrete: r.is_discrete }); after = code; }
	}
	return { categories: categories.map(parseCategory), definitions: definitions.map(parseDefinition), units, shelf };
}
export function generateProductCode(family: ProductFamily, cryptoSource: Pick<Crypto, 'getRandomValues'> = crypto): string {
	if (!productFamilies.includes(family)) throw new Error('Invalid product family');
	const bytes = cryptoSource.getRandomValues(new Uint8Array(3)); return `${family}-${Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('').slice(0, 5).toUpperCase()}`;
}
export type ProductAttributeDraft = Omit<AttributeValue, 'product_id'>;
export type ProductCommand = { userId: string; payload: ProductWrite; revision: string | null; attributes?: ProductAttributeDraft[]; attributeBefore?: ProductAttributeDraft[] };
export class ProductSpecificationsError extends Error {
	constructor(cause: unknown) { super('Product saved; specifications incomplete', { cause }); }
}
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
function commandAttributeBefore(command: ProductCommand): ProductAttributeDraft[] | undefined {
	if (command.attributeBefore === undefined) return undefined;
	if (!command.attributes) throw new Error('Missing intended specifications');
	return commandAttributes({ ...command, attributes: command.attributeBefore });
}
export const productCommandKey = 'ampoteket:admin-product:v1';
export function readProductCommand(storage: Pick<Storage, 'getItem'>): ProductCommand | null {
	const raw = storage.getItem(productCommandKey); if (!raw) return null; const c = object(JSON.parse(raw));
	if (c.revision !== null && (typeof c.revision !== 'string' || !/^[1-9]\d*$/.test(c.revision))) throw new Error('Invalid command revision');
	const command: ProductCommand = { userId: identifier(c.userId), payload: parseProductWrite(c.payload), revision: c.revision as string | null };
	if ('attributes' in c) command.attributes = commandAttributes({ ...command, attributes: c.attributes as ProductAttributeDraft[] });
	if ('attributeBefore' in c) command.attributeBefore = commandAttributeBefore({ ...command, attributeBefore: c.attributeBefore as ProductAttributeDraft[] });
	return command;
}
export function persistProductCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: ProductCommand): void {
	const previous = readProductCommand(storage);
	if (previous && !sameCommand(previous, command)) throw new Error('Unresolved product command');
	const serialized = JSON.stringify({ ...command, payload: parseProductWrite(command.payload), ...(command.attributes === undefined ? {} : { attributes: commandAttributes(command) }), ...(command.attributeBefore === undefined ? {} : { attributeBefore: commandAttributeBefore(command) }) }); storage.setItem(productCommandKey, serialized);
	if (storage.getItem(productCommandKey) !== serialized) throw new Error('Product persistence unavailable');
}
export function clearProductCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: ProductCommand): void {
	const current = readProductCommand(storage); if (current && sameCommand(current, command)) storage.removeItem(productCommandKey);
}
function sameCommand(a: ProductCommand, b: ProductCommand): boolean { return a.userId === b.userId && a.revision === b.revision && JSON.stringify(parseProductWrite(a.payload)) === JSON.stringify(parseProductWrite(b.payload)) && JSON.stringify(commandAttributes(a)) === JSON.stringify(commandAttributes(b)) && JSON.stringify(commandAttributeBefore(a)) === JSON.stringify(commandAttributeBefore(b)); }
export type ProductSpecificationReview = { product: AdminProduct; attributes: AttributeValue[] };
function reviewProductIdentity(command: ProductCommand, product: AdminProduct) {
	if (command.revision !== null || command.attributes === undefined || ['id', 'code', 'unit_code', 'stock_step'].some(key => command.payload[key as keyof ProductWrite] !== product[key as keyof ProductWrite])) throw new Error('Product review identity changed');
}
export async function readProductSpecificationReview(session: StaffSession, command: ProductCommand, fetcher: Fetcher = fetch): Promise<ProductSpecificationReview> {
	if (session.userId !== command.userId) throw new Error('Product identity changed');
	const [product, attributes] = await Promise.all([readProduct(session, command.payload.id, fetcher), readProductAttributes(session, command.payload.id, fetcher)]);
	if (!product) throw new StaleProductError();
	reviewProductIdentity(command, product);
	return { product, attributes };
}
/** Called only after the operator has reviewed current values and their draft.
 * Replace in one storage write; a failed write must retain the original retry. */
export function replaceReviewedProductCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, original: ProductCommand, review: ProductSpecificationReview, attributes: ProductAttributeDraft[]): ProductCommand {
	const current = readProductCommand(storage);
	if (!current || !sameCommand(current, original)) throw new Error('Product command changed');
	reviewProductIdentity(original, review.product);
	const reviewedIds = new Set([...(original.attributes ?? []), ...(original.attributeBefore ?? []), ...attributes].map(value => value.attribute_id));
	const attributeBefore = review.attributes.map(value => {
		const { product_id, ...row } = parseAttribute(value);
		if (product_id !== original.payload.id) throw new Error('Specification review identity changed');
		return row;
	}).filter(value => reviewedIds.has(value.attribute_id));
	const replacement: ProductCommand = { ...original, payload: parseProductWrite(review.product), attributes, attributeBefore };
	replacement.attributes = commandAttributes(replacement);
	replacement.attributeBefore = commandAttributeBefore(replacement);
	const raw = JSON.stringify(replacement);
	storage.setItem(productCommandKey, raw);
	if (storage.getItem(productCommandKey) !== raw) throw new Error('Product persistence unavailable');
	return replacement;
}
export class StaleProductError extends Error {}
export function sameProduct(product: AdminProduct, payload: ProductWrite): boolean { return (Object.keys(payload) as (keyof ProductWrite)[]).every(key => product[key] === payload[key]); }
/** The original product command is persisted before this auxiliary write. A
 * lost category reply is reconciled by its stable ID on the same product retry. */
async function ensureProductCategory(session: StaffSession, categoryId: string | null, fetcher: Fetcher): Promise<void> {
	const type = productTypes.find(type => type.id === categoryId);
	if (!type) return; // Existing categories keep their original database identity.
	const category = { id: type.id, name: type.name };
	const query = { select: 'id,name', id: `eq.${category.id}`, limit: '2' };
	function matches(raw: unknown): boolean {
		if (!Array.isArray(raw) || raw.length > 1) throw new Error('Invalid category acknowledgement');
		if (!raw.length) return false;
		const row = parseCategory(raw[0]);
		if (row.id !== category.id || row.name !== category.name) throw new Error('Category identity differs');
		return true;
	}
	if (matches(await staffRequest(session, 'amp_categories', query, undefined, 'POST', fetcher))) return;
	try {
		if (!matches(await staffRequest(session, 'amp_categories', { select: 'id,name' }, category, 'POST', fetcher))) throw new Error('Missing category acknowledgement');
	} catch (error) {
		// Concurrent first uses may insert the same category. Only a definite
		// unique violation allows reconciliation within this attempt.
		if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== 'object' || !('code' in error.body) || error.body.code !== '23505') throw error;
		if (!matches(await staffRequest(session, 'amp_categories', query, undefined, 'POST', fetcher))) throw error;
	}
}
export async function executeProductCommand(session: StaffSession, command: ProductCommand, fetcher: Fetcher = fetch): Promise<AdminProduct> {
	const attributes = commandAttributes(command);
	const before = commandAttributeBefore(command);
	const product = await executeProductMetadata(session, command, fetcher);
	try {
		for (const value of attributes ?? []) {
			const previous = before?.find(row => row.attribute_id === value.attribute_id);
			await executeDetailCommand(session, { userId: command.userId, kind: 'attribute', before: previous ? { ...previous, product_id: product.id } : null, after: { ...value, product_id: product.id } }, fetcher);
		}
		for (const previous of before ?? []) {
			if (!attributes?.some(value => value.attribute_id === previous.attribute_id)) await executeDetailCommand(session, { userId: command.userId, kind: 'attribute', before: { ...previous, product_id: product.id }, after: null }, fetcher);
		}
	} catch (error) { throw new ProductSpecificationsError(error); }
	return product;
}
async function executeProductMetadata(session: StaffSession, command: ProductCommand, fetcher: Fetcher): Promise<AdminProduct> {
	if (session.userId !== command.userId) throw new Error('Product identity changed');
	const current = await readProduct(session, command.payload.id, fetcher);
	if (current && sameProduct(current, command.payload)) return current;
	if (current && command.revision === null && command.attributes !== undefined) throw new ProductSpecificationsError(new StaleProductError());
	if ((command.revision === null && current) || (command.revision !== null && (!current || current.metadata_revision !== command.revision))) throw new StaleProductError();
	await ensureProductCategory(session, command.payload.category_id, fetcher);
	const { id, code, stock_step, unit_code, ...editable } = command.payload;
	const raw = await staffRequest(session, 'amp_products', command.revision === null ? { select: productSelect } : { select: productSelect, id: `eq.${id}`, metadata_revision: `eq.${command.revision}` }, command.revision === null ? command.payload : editable, command.revision === null ? 'POST' : 'PATCH', fetcher);
	if (!Array.isArray(raw) || raw.length > 1) throw new Error('Invalid product write acknowledgement');
	if (!raw.length) throw new StaleProductError();
	const result = parseAdminProduct(raw[0]); if (!sameProduct(result, command.payload)) throw new Error('Product write differs'); return result;
}
export function isProductCodeCollision(error: unknown): boolean {
	if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== 'object') return false;
	const body = error.body as Record<string, unknown>; return body.code === '23505' && typeof body.message === 'string' && /\bproducts_code_key\b/.test(body.message);
}
export function definitiveProductFailure(error: unknown): boolean {
	return error instanceof ApiError && [400, 404, 409, 422].includes(error.status) && Boolean(error.body && typeof error.body === 'object' && 'code' in error.body);
}

/** These independent metadata edits use the shown value as a compare-and-set guard.
 * No delete+insert replacement: an unknown response is resolved by re-reading the same key. */
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
function sameDetail(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function ensureProductSpecification(session: StaffSession, attributeId: string, fetcher: Fetcher): Promise<void> {
	const standard = standardSpecifications.find(definition => definition.id === attributeId);
	if (!standard) return;
	const expected: AttributeDefinition = standard;
	const select = 'id,code,label,value_type,canonical_unit';
	const query = { select, id: `eq.${standard.id}`, limit: '2' };
	function matches(raw: unknown): boolean {
		if (!Array.isArray(raw) || raw.length > 1) throw new Error('Invalid specification acknowledgement');
		if (!raw.length) return false;
		const row = parseDefinition(raw[0]);
		if (row.id !== expected.id || row.code !== expected.code || row.value_type !== expected.value_type || row.canonical_unit !== expected.canonical_unit) throw new Error('Specification identity differs');
		return true;
	}
	if (matches(await staffRequest(session, 'amp_attribute_definitions', query, undefined, 'POST', fetcher))) return;
	try {
		if (!matches(await staffRequest(session, 'amp_attribute_definitions', { select }, standard, 'POST', fetcher))) throw new Error('Missing specification acknowledgement');
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== 'object' || !('code' in error.body) || error.body.code !== '23505') throw error;
		if (!matches(await staffRequest(session, 'amp_attribute_definitions', query, undefined, 'POST', fetcher))) throw error;
	}
}
export async function executeDetailCommand(session: StaffSession, command: DetailCommand, fetcher: Fetcher = fetch): Promise<void> {
	if (session.userId !== command.userId) throw new Error('Detail identity changed');
	const c = parseDetailCommand(command); const key = (c.after ?? c.before)!;
	const view = c.kind === 'category' ? 'amp_categories' : c.kind === 'definition' ? 'amp_attribute_definitions' : 'amp_product_attributes';
	const parse = c.kind === 'category' ? parseCategory : c.kind === 'definition' ? parseDefinition : parseAttribute;
	const select = c.kind === 'category' ? 'id,name' : c.kind === 'definition' ? 'id,code,label,value_type,canonical_unit' : 'product_id,attribute_id,number_value,text_value,boolean_value';
	const query: Record<string, string> = 'id' in key ? { id: `eq.${key.id}` } : { product_id: `eq.${key.product_id}`, attribute_id: `eq.${key.attribute_id}` };
	const raw = await staffRequest(session, view, { ...query, select, limit: '2' }, undefined, 'POST', fetcher);
	if (!Array.isArray(raw) || raw.length > 1) throw new Error('Invalid detail read');
	const current = raw.length ? parse(raw[0]) : null;
	if (sameDetail(current, c.after)) return;
	if (!sameDetail(current, c.before)) throw new StaleProductError();
	// The caller has already frozen this attribute command. Create only its
	// missing predefined definition; a lost reply is reconciled on the same retry.
	if (c.kind === 'attribute' && c.after) await ensureProductSpecification(session, (c.after as AttributeValue).attribute_id, fetcher);
	const filters = { ...query }; if (c.before) for (const [k, v] of Object.entries(c.before)) if (!(k in query)) filters[k] = staffEquals(v);
	let payload: unknown = c.after;
	if (c.before && c.after) {
		if (c.kind === 'category') payload = { name: (c.after as Category).name };
		else if (c.kind === 'definition') payload = { label: (c.after as AttributeDefinition).label };
		else { const a = c.after as AttributeValue; payload = { number_value: a.number_value, text_value: a.text_value, boolean_value: a.boolean_value }; }
	}
	const saved = await staffRequest(session, view, c.before ? { ...filters, select } : { select }, c.after ? payload : undefined, !c.after ? 'DELETE' : c.before ? 'PATCH' : 'POST', fetcher);
	if (!Array.isArray(saved) || saved.length > 1) throw new Error('Invalid detail acknowledgement');
	if (!saved.length) throw new StaleProductError();
	if (!sameDetail(parse(saved[0]), c.after ?? c.before)) throw new Error('Detail acknowledgement differs');
}
