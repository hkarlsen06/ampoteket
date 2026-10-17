import { isRecord } from './api';
import { api, errorCode, type ConvexCaller } from './convex';
import { messagesFor, specificationLabel, type Locale } from './i18n';
import { formatMeasurementText, formatSpecificationNumber } from './format';
import { CatalogQueryError, sortCatalogCategories, type CatalogFacets, type CatalogQuery } from './catalog-search';
import { compareDecimals, normalizeDecimal } from './decimal';
export type { CatalogFacets } from './catalog-search';
import type { CatalogAttribute, CatalogOffShelf, CatalogPlacement, CatalogProduct } from './catalog-types';
export type { CatalogAttribute, CatalogOffShelf, CatalogPlacement, CatalogProduct } from './catalog-types';

/** The displayed product name follows the UI language. */
export function productName(product: { name_nb: string; name_en: string }, locale: Locale): string {
	return formatMeasurementText(locale === 'nb' ? product.name_nb : product.name_en, locale);
}
/** What tells the product from look-alikes, one entry per specification, such as
 * "350 V" or "Package: TO-220"; empty when nothing does. A value with a unit names
 * itself, as on shelf labels. */
export function productVariants(product: Pick<CatalogProduct, 'attributes' | 'distinguishing'>, locale: Locale): string[] {
	return product.distinguishing.flatMap(code => {
		const attribute = Object.hasOwn(product.attributes, code) ? product.attributes[code] : undefined;
		if (!attribute || attribute.value === '') return [];
		if (attribute.value_type === 'number' && attribute.unit) return [formatSpecificationNumber(attribute.value, attribute.max, attribute.unit, locale)];
		const shown = attribute.value_type === 'boolean' ? messagesFor(locale).shop[attribute.value ? 'yes' : 'no']
			: attribute.value_type === 'number' ? formatSpecificationNumber(attribute.value, attribute.max, null, locale) : attribute.value;
		return [`${specificationLabel(code, attribute, locale)}: ${shown}`];
	});
}
/** A Convex read cannot be cancelled; aborting rejects at once and drops a late result. */
export type CatalogRequestOptions = { signal?: AbortSignal };
export type CatalogPageOptions = CatalogRequestOptions & { afterCode?: string; limit?: number; query?: CatalogQuery; binId?: string };

/** Only these can go in the cart; staff alone change a borrow-only product's stock. */
export type SaleProduct = CatalogProduct & { sale_unit_price_nok: string };
export const forSale = (product: CatalogProduct): product is SaleProduct => product.sale_unit_price_nok !== null;

export type CatalogPage = {
	products: CatalogProduct[];
	/** No matching product follows this page. */
	complete: boolean;
	nextAfterCode: string | null;
};

export class CatalogResponseError extends Error {
	constructor() {
		// Do not include raw response contents or configuration in error messages.
		super('Invalid catalog response');
		this.name = 'CatalogResponseError';
	}
}

const productCode = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const attributeCode = /^[a-z][a-z0-9_]{0,63}$/;
const unitCode = /^[a-z][a-z0-9_]{0,23}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function invalid(): never {
	throw new CatalogResponseError();
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) invalid();
	return value;
}

function string(value: unknown): string {
	if (typeof value !== 'string') invalid();
	return value;
}

function nullableString(value: unknown): string | null {
	return value === null ? null : string(value);
}

function named(value: unknown, maxLength: number): string {
	const text = string(value);
	// Length counts code points after trimming spaces, as the stored names are checked.
	const length = [...text.replace(/^ +| +$/g, '')].length;
	if (length < 1 || length > maxLength) invalid();
	return text;
}

function matching(value: unknown, pattern: RegExp): string {
	const text = string(value);
	if (!pattern.test(text)) invalid();
	return text;
}

function exactDecimal(value: unknown, kind: 'attribute' | 'balance' | 'price' | 'step'): string {
	const text = string(value);
	const match = decimal.exec(text);
	if (!match) invalid();
	const whole = match[1];
	const fraction = (match[2] ?? '').replace(/0+$/, '');
	const zero = whole === '0' && fraction === '';
	// Attribute numeric is unconstrained; balances have precision but no magnitude cap.
	if (kind !== 'attribute' && fraction.length > 6) invalid();
	if (kind === 'price' || kind === 'step') {
		if (text.startsWith('-') && !zero) invalid();
		if (whole.length > 12 || (whole === '999999999999' && fraction !== '')) invalid();
		if (kind === 'step' && zero) invalid();
	}
	return text;
}

function coordinate(value: unknown): number {
	// Structural positive integers (coordinates, grid sizes), never domain decimals.
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) invalid();
	return value;
}

function timestamp(value: unknown): string | null {
	if (value === null) return null;
	const text = matching(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
	if (!Number.isFinite(Date.parse(text))) invalid();
	return text;
}

function datasheet(value: unknown): string | null {
	if (value === null) return null;
	const text = string(value);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		invalid();
	}
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid();
	return text;
}

/** Only numbers have an upper bound; the backend omits `max` for text and booleans. */
const noRange = (item: Record<string, unknown>) => item.max === undefined || item.max === null;

function attributes(value: unknown): Record<string, CatalogAttribute> {
	const entries = Object.entries(record(value)).map(([code, raw]) => {
		if (!attributeCode.test(code)) invalid();
		const item = record(raw);
		const label = named(item.label, 100);
		let attribute: CatalogAttribute;
		switch (item.value_type) {
			case 'number': {
				const value = exactDecimal(item.value, 'attribute');
				const max = item.max === null ? null : exactDecimal(item.max, 'attribute');
				if (max !== null && compareDecimals(max, value) <= 0) invalid();
				attribute = { label, unit: nullableString(item.unit), value_type: 'number', value, max };
				break;
			}
			case 'text': {
				const text = string(item.value);
				if (item.unit !== null || !noRange(item) || [...text].length > 2000) invalid();
				attribute = { label, unit: null, value_type: 'text', value: text };
				break;
			}
			case 'boolean':
				if (item.unit !== null || !noRange(item) || typeof item.value !== 'boolean') invalid();
				attribute = { label, unit: null, value_type: 'boolean', value: item.value };
				break;
			default:
				invalid();
		}
		return [code, attribute] as const;
	});
	return Object.fromEntries(entries);
}

function distinguishing(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 8) invalid();
	const codes = value.map(code => matching(code, attributeCode));
	if (new Set(codes).size !== codes.length) invalid();
	return codes;
}

/** Validate one catalog row; missing fields fail closed. */
export function parseCatalogProduct(value: unknown): CatalogProduct {
	const row = record(value);
	const result: CatalogProduct = {
		product_id: matching(row.product_id, uuid),
		code: matching(row.code, productCode),
		name_nb: named(row.name_nb, 200),
		name_en: named(row.name_en, 200),
		description: nullableString(row.description),
		category_name: row.category_name === null ? null : named(row.category_name, 100),
		unit_code: matching(row.unit_code, unitCode),
		unit_symbol: string(row.unit_symbol),
		sale_step: exactDecimal(row.sale_step, 'step'),
		sale_unit_price_nok: row.sale_unit_price_nok === null ? null : exactDecimal(row.sale_unit_price_nok, 'price'),
		quantity: exactDecimal(row.quantity, 'balance'),
		last_counted_at: timestamp(row.last_counted_at),
		datasheet_url: datasheet(row.datasheet_url),
		attributes: attributes(row.attributes),
		distinguishing: distinguishing(row.distinguishing),
		...placement(row)
	};
	return result;
}

// Either every location column describes a live bin that fits inside its
// cabinet, or all are null and an optional note says where the stock is.
function placement(row: Record<string, unknown>): CatalogPlacement | CatalogOffShelf {
	if (row.bin_code === null) {
		for (const key of ['cabinet_code', 'outer_row', 'outer_col', 'inner_rows', 'inner_cols', 'bin_label', 'inner_row', 'inner_col', 'row_span', 'col_span']) {
			if (row[key] !== null) invalid();
		}
		return { cabinet_code: null, outer_row: null, outer_col: null, inner_rows: null, inner_cols: null, bin_code: null, bin_label: null,
			inner_row: null, inner_col: null, row_span: null, col_span: null, location_note: row.location_note === null ? null : named(row.location_note, 200) };
	}
	if (row.location_note !== null) invalid();
	const result: CatalogPlacement = {
		cabinet_code: named(row.cabinet_code, 64),
		outer_row: coordinate(row.outer_row),
		outer_col: coordinate(row.outer_col),
		inner_rows: coordinate(row.inner_rows),
		inner_cols: coordinate(row.inner_cols),
		bin_code: named(row.bin_code, 64),
		bin_label: nullableString(row.bin_label),
		inner_row: coordinate(row.inner_row),
		inner_col: coordinate(row.inner_col),
		row_span: coordinate(row.row_span),
		col_span: coordinate(row.col_span),
		location_note: null
	};
	if (result.inner_row + result.row_span - 1 > result.inner_rows
		|| result.inner_col + result.col_span - 1 > result.inner_cols) invalid();
	return result;
}

/** Validate a list of catalog rows: each one, and no repeated code or identity. */
export function parseCatalogProducts(value: unknown): CatalogProduct[] {
	if (!Array.isArray(value)) invalid();
	const products = value.map(parseCatalogProduct);
	const codes = new Set<string>();
	const ids = new Set<string>();
	for (const product of products) {
		if (codes.has(product.code) || ids.has(product.product_id)) invalid();
		codes.add(product.code);
		ids.add(product.product_id);
	}
	return products;
}

function validateCode(code: string): void {
	if (!productCode.test(code)) throw new TypeError('Invalid catalog code');
}

function pageLimit(limit = 200): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid catalog page size');
	return limit;
}

/** Settle with the read, or reject as soon as `signal` aborts. */
export function abortable<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return read;
	if (signal.aborted) { read.catch(() => {}); return Promise.reject(signal.reason); }
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		read.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

const issues = { INVALID_CATALOG_QUERY: 'invalidQuery', INVALID_CATALOG_FILTER: 'invalidFilter',
	UNKNOWN_CATALOG_CATEGORY: 'unknownCategory', UNKNOWN_CATALOG_ATTRIBUTE: 'unknownAttribute', CATALOG_CURSOR_MISSING: 'missingCursor' } as const;

/** A rejected query becomes a CatalogQueryError; anything else (network, server) stays unavailable. */
async function read<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	try { return await abortable(request(), signal); } catch (error) {
		const code = errorCode(error);
		if (code !== null && Object.hasOwn(issues, code)) throw new CatalogQueryError(issues[code as keyof typeof issues]);
		throw error;
	}
}

/** A direct lookup is independent of browse pagination. Null means a valid empty read. */
export async function lookupCatalogProduct(
	client: ConvexCaller,
	code: string,
	options: CatalogRequestOptions & { allowCompactCode?: boolean } = {}
): Promise<CatalogProduct | null> {
	validateCode(code);
	const raw = await read(() => client.query(api.catalog.product, { code }), options.signal);
	const found = raw === null ? null : parseCatalogProduct(raw);
	if (found && found.code !== code) invalid();
	if (found) return found;
	// Manual input may omit the standard separator; an existing legacy code wins.
	const formatted = code.replace(/^([A-Z]{3})([A-F0-9]{5})$/, '$1-$2');
	return options.allowCompactCode && formatted !== code
		? lookupCatalogProduct(client, formatted, { ...options, allowCompactCode: false }) : null;
}

/** One page in the server's catalog order; SSR and no-JavaScript browse links page with `after`. */
export async function readCatalogPage(
	client: ConvexCaller,
	options: CatalogPageOptions = {}
): Promise<CatalogPage> {
	const afterCode = options.afterCode ?? (options.query?.after || undefined);
	if (afterCode !== undefined) validateCode(afterCode);
	if (options.binId !== undefined && !uuid.test(options.binId)) throw new TypeError('Invalid drawer identity');
	const limit = pageLimit(options.limit);
	const query = options.query;
	const raw = record(await read(() => client.query(api.catalog.page, {
		limit,
		...(afterCode === undefined ? {} : { afterCode }),
		...(options.binId === undefined ? {} : { binId: options.binId }),
		...(query ? { q: query.q, categories: query.categories, cabinetIds: query.cabinetIds, binIds: query.binIds,
			conditions: Object.fromEntries(Object.entries(query.conditions).map(([code, condition]) =>
				[code, Object.fromEntries(Object.entries(condition).filter(([, value]) => value !== undefined))])) } : {})
	}), options.signal));
	const products = parseCatalogProducts(raw.products);
	if (typeof raw.complete !== 'boolean' || products.length > limit || products.some((product) => product.code === afterCode)
		|| raw.nextAfterCode !== (products.at(-1)?.code ?? null) || (!raw.complete && !products.length)) invalid();
	return { products, complete: raw.complete, nextAfterCode: products.at(-1)?.code ?? null };
}

/**
 * Every matching row (for example one drawer), published only once the server
 * says nothing follows. The server owns the order; the seen checks catch
 * repeated cursors and cycles. A failed or cancelled traversal rejects and never
 * returns partial success.
 */
export async function readCompleteCatalog(
	client: ConvexCaller,
	options: CatalogRequestOptions & { limit?: number; binId?: string } = {}
): Promise<CatalogProduct[]> {
	const products: CatalogProduct[] = [];
	const codes = new Set<string>();
	const ids = new Set<string>();
	let afterCode: string | undefined;
	for (;;) {
		options.signal?.throwIfAborted();
		const page = await readCatalogPage(client, { ...options, afterCode });
		for (const product of page.products) {
			if (codes.has(product.code) || ids.has(product.product_id)) invalid();
			codes.add(product.code);
			ids.add(product.product_id);
			products.push(product);
		}
		if (page.complete) return products;
		afterCode = page.nextAfterCode!;
	}
}

/** Categories with active products and every specification's values within the selected categories. */
export async function readCatalogFacets(client: ConvexCaller,
	options: CatalogRequestOptions & { categories?: string[] } = {}): Promise<CatalogFacets> {
	const raw = record(await read(() => client.query(api.catalog.facets, { categories: options.categories ?? [] }), options.signal));
	if (!Array.isArray(raw.categories) || !Array.isArray(raw.attributes)) invalid();
	const categories = raw.categories.map(value => named(value, 100));
	if (new Set(categories).size !== categories.length) invalid();
	const codes = new Set<string>();
	const facets = raw.attributes.map(value => {
		const row = record(value), code = matching(row.code, attributeCode);
		if (codes.has(code) || !Array.isArray(row.values)) invalid();
		codes.add(code);
		const definition = attributes({ [code]: row.definition })[code];
		const values = row.values.map(value => definition.value_type === 'number'
			? normalizeDecimal(exactDecimal(value, 'attribute')) : string(value));
		if (new Set(values).size !== values.length || (definition.value_type === 'boolean' && values.length)
			|| (definition.value_type !== 'boolean' && !values.length)
			|| (definition.value_type === 'text' && values.some(value => [...value].length > 2000))
			|| (definition.value_type === 'number' && values.some((value, index) => index > 0 && compareDecimals(values[index - 1], value) >= 0))) invalid();
		return { code, definition, values };
	});
	return { categories: sortCatalogCategories(categories), attributes: facets };
}
