import { ApiError, isRecord, requestApiJson, type Fetcher } from './api';
import type { Locale } from './i18n';
import { formatMeasurementText } from './format';
import { catalogSearchLabels, CatalogQueryError, sortCatalogCategories, type CatalogFacets, type CatalogQuery } from './catalog-search';
import { compareDecimals, normalizeDecimal } from './decimal';
import { catalogSort } from './product-specifications';
export type { CatalogFacets } from './catalog-search';

/** Public configuration only. Never pass a server secret key to this module. */
export type CatalogConfig = { url: string; publishableKey: string };

/** The displayed product name follows the UI language. */
export function productName(product: { name_nb: string; name_en: string }, locale: Locale): string {
	return formatMeasurementText(locale === 'nb' ? product.name_nb : product.name_en, locale);
}
export type CatalogRequestOptions = { fetcher?: Fetcher; signal?: AbortSignal };
export type CatalogPageOptions = CatalogRequestOptions & { afterCode?: string; limit?: number; query?: CatalogQuery; binId?: string };

export type CatalogAttribute =
	| { label: string; unit: string | null; value_type: 'number'; value: string }
	| { label: string; unit: null; value_type: 'text'; value: string }
	| { label: string; unit: null; value_type: 'boolean'; value: boolean };

export type CatalogProduct = {
	product_id: string;
	code: string;
	/** Product names are published in both UI languages; pick with productName(). */
	name_nb: string;
	name_en: string;
	description: string | null;
	category_name: string | null;
	unit_code: string;
	unit_symbol: string;
	sale_step: string;
	sale_unit_price_nok: string;
	quantity: string;
	last_counted_at: string | null;
	datasheet_url: string | null;
	attributes: Record<string, CatalogAttribute>;
} & (CatalogPlacement | CatalogOffShelf);

/** A live drawer on the wall. Narrow with `product.bin_code !== null`. */
export type CatalogPlacement = {
	cabinet_code: string;
	outer_row: number;
	outer_col: number;
	inner_rows: number;
	inner_cols: number;
	bin_code: string;
	bin_label: string | null;
	inner_row: number;
	inner_col: number;
	row_span: number;
	col_span: number;
	location_note: null;
};
/** Stock kept outside the drawer wall, with an optional staff-written hint. */
export type CatalogOffShelf = { [K in Exclude<keyof CatalogPlacement, 'location_note'>]: null } & { location_note: string | null };

export type CatalogPage = {
	products: CatalogProduct[];
	/** Only an empty API response proves the end, even after a short page. */
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
	// PostgreSQL length counts code points and btrim's default removes spaces.
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
	const text = matching(value, /^[1-9][0-9]*$/);
	const number = Number(text);
	// These are PostgreSQL positive int4 coordinates, not domain decimal values.
	if (!Number.isSafeInteger(number) || number > 2147483647) invalid();
	return number;
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

function attributes(value: unknown): Record<string, CatalogAttribute> {
	const entries = Object.entries(record(value)).map(([code, raw]) => {
		if (!attributeCode.test(code)) invalid();
		const item = record(raw);
		const label = named(item.label, 100);
		let attribute: CatalogAttribute;
		switch (item.value_type) {
			case 'number':
				attribute = { label, unit: nullableString(item.unit), value_type: 'number', value: exactDecimal(item.value, 'attribute') };
				break;
			case 'text': {
				const text = string(item.value);
				if (item.unit !== null || [...text].length > 2000) invalid();
				attribute = { label, unit: null, value_type: 'text', value: text };
				break;
			}
			case 'boolean':
				if (item.unit !== null || typeof item.value !== 'boolean') invalid();
				attribute = { label, unit: null, value_type: 'boolean', value: item.value };
				break;
			default:
				invalid();
		}
		return [code, attribute] as const;
	});
	return Object.fromEntries(entries);
}

function product(value: unknown): CatalogProduct {
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
		sale_unit_price_nok: exactDecimal(row.sale_unit_price_nok, 'price'),
		quantity: exactDecimal(row.quantity, 'balance'),
		last_counted_at: timestamp(row.last_counted_at),
		datasheet_url: datasheet(row.datasheet_url),
		attributes: attributes(row.attributes),
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

/** Validate a raw lossless-decoded public RPC page; missing fields fail closed. */
export function parseCatalogProducts(value: unknown): CatalogProduct[] {
	if (!Array.isArray(value)) invalid();
	const products = value.map(product);
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

async function requestCatalog(
	config: CatalogConfig,
	body: Record<string, unknown>,
	options: CatalogRequestOptions,
	rpc = 'amp_catalog'
): Promise<unknown> {
	const url = new URL(config.url);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
		|| url.pathname !== '/' || url.search || url.hash || !config.publishableKey.trim()
		|| config.publishableKey.startsWith('sb_secret_')) {
		throw new TypeError('Invalid public catalog configuration');
	}
	url.pathname = `/rest/v1/rpc/${rpc}`;
	try { return await requestApiJson(url, {
		method: 'POST',
		headers: { apikey: config.publishableKey, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify(body),
		credentials: 'omit',
		cache: 'no-store',
		signal: options.signal
	}, options.fetcher); } catch (error) {
		if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'message' in error.body) {
			const issues = { INVALID_CATALOG_QUERY: 'invalidQuery', INVALID_CATALOG_FILTER: 'invalidFilter',
				UNKNOWN_CATALOG_CATEGORY: 'unknownCategory', UNKNOWN_CATALOG_ATTRIBUTE: 'unknownAttribute', CATALOG_CURSOR_MISSING: 'missingCursor' } as const;
			const message = error.body.message;
			if (typeof message === 'string' && Object.hasOwn(issues, message)) throw new CatalogQueryError(issues[message as keyof typeof issues]);
		}
		throw error;
	}
}

/** A direct lookup is independent of browse pagination. Null means a valid empty read. */
export async function lookupCatalogProduct(
	config: CatalogConfig,
	code: string,
	options: CatalogRequestOptions & { allowCompactCode?: boolean } = {}
): Promise<CatalogProduct | null> {
	validateCode(code);
	const products = parseCatalogProducts(await requestCatalog(config, { p_code: code }, options));
	if (products.length > 1 || (products.length === 1 && products[0].code !== code)) invalid();
	if (products.length) return products[0];
	// Manual input may omit the standard separator; an existing legacy code wins.
	const formatted = code.replace(/^([A-Z]{3})([A-F0-9]{5})$/, '$1-$2');
	return options.allowCompactCode && formatted !== code
		? lookupCatalogProduct(config, formatted, { ...options, allowCompactCode: false }) : null;
}

/** Exposes incomplete/end states for SSR and explicit no-JavaScript browse links. */
export async function readCatalogPage(
	config: CatalogConfig,
	options: CatalogPageOptions = {}
): Promise<CatalogPage> {
	const afterCode = options.afterCode ?? (options.query?.after || undefined);
	if (afterCode !== undefined) validateCode(afterCode);
	if (options.binId !== undefined && !uuid.test(options.binId)) throw new TypeError('Invalid drawer identity');
	const limit = pageLimit(options.limit);
	const products = parseCatalogProducts(await requestCatalog(config, {
		p_after_code: afterCode ?? null,
		p_limit: limit,
		p_sort: catalogSort,
		...(options.binId === undefined ? {} : { p_bin_id: options.binId }),
		...(options.query ? { p_q: options.query.q, p_categories: options.query.categories, p_conditions: options.query.conditions,
			p_cabinet_ids: options.query.cabinetIds, p_bin_ids: options.query.binIds,
			...(options.query.q ? { p_labels: catalogSearchLabels() } : {}) } : {})
	}, options));
	if (products.length > limit || products.some((product) => product.code === afterCode)) invalid();
	return {
		products,
		complete: products.length === 0,
		nextAfterCode: products.at(-1)?.code ?? null
	};
}

/**
 * Publish complete matching rows (for example one drawer) only after the final empty page.
 * SQL owns the order (category, primary specification, name, code): equality/seen checks catch repeated
 * cursors and cycles without applying a different browser string ordering.
 * A failed or cancelled traversal rejects and never returns partial success.
 */
export async function readCompleteCatalog(
	config: CatalogConfig,
	options: CatalogRequestOptions & { limit?: number; binId?: string } = {}
): Promise<CatalogProduct[]> {
	const products: CatalogProduct[] = [];
	const codes = new Set<string>();
	const ids = new Set<string>();
	let afterCode: string | undefined;
	for (;;) {
		options.signal?.throwIfAborted();
		const page = await readCatalogPage(config, { ...options, afterCode });
		if (page.complete) return products;
		for (const product of page.products) {
			if (codes.has(product.code) || ids.has(product.product_id)) invalid();
			codes.add(product.code);
			ids.add(product.product_id);
			products.push(product);
		}
		afterCode = page.nextAfterCode!;
	}
}

/** One JSON object carries complete public facets independently of API row caps. */
export async function readCatalogFacets(config: CatalogConfig,
	options: CatalogRequestOptions & { categories?: string[] } = {}): Promise<CatalogFacets> {
	const raw = record(await requestCatalog(config, { p_categories: options.categories ?? [] }, options, 'amp_catalog_facets'));
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
