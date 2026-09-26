import { isRecord } from './api';
import { compareDecimals, validQuantity } from './decimal';

export const checkoutUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
export type CheckoutBinding = { request_id: string; fingerprint: string };
export type PrepareCheckoutRequest = CheckoutBinding & {
	items: { product_id: string; quantity: string }[];
	contact: string | null;
};
export type CheckoutSnapshot = {
	checkout_id: string;
	created_at: string;
	status: 'unconfirmed' | 'confirmed';
	confirmed_at: string | null;
	total_nok: string;
	payment_required: boolean;
	registration_method: null | 'buyer' | 'staff_recovery';
	contact_text: string | null;
	items: {
		product_id: string; code: string; name_nb: string; name_en: string; unit: string;
		quantity: string; unit_price_nok: string; line_total_nok: string;
	}[];
};

function invalid(): never { throw new Error('INVALID_CHECKOUT_DATA'); }
function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return invalid();
	return value;
}
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== 'string' || !pattern.test(value)) return invalid();
	return value;
}
function exactKeys(row: Record<string, unknown>, keys: string[]) {
	if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) invalid();
}
function name(value: unknown): string {
	if (typeof value !== 'string' || !value.trim() || [...value].length > 1000) return invalid();
	return value;
}
function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)
		|| !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
	return value;
}
function decimal(value: unknown, scale: number): string {
	return text(value, new RegExp(`^(0|[1-9][0-9]{0,39})(?:\\.[0-9]{1,${scale}})?$`));
}

export function parseCheckoutBinding(value: unknown, preparing = false): CheckoutBinding {
	const row = record(value);
	exactKeys(row, preparing ? ['request_id', 'fingerprint', 'items', 'contact'] : ['request_id', 'fingerprint']);
	return { request_id: text(row.request_id, requestUuid), fingerprint: text(row.fingerprint, fingerprintPattern) };
}

/** Preserve the frozen payload byte values; validation never silently rewrites a retry. */
export function parsePrepareRequest(value: unknown): PrepareCheckoutRequest {
	const binding = parseCheckoutBinding(value, true);
	const row = record(value);
	if (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > 200) return invalid();
	const ids = new Set<string>();
	const items = row.items.map((value) => {
		const item = record(value);
		exactKeys(item, ['product_id', 'quantity']);
		const product_id = text(item.product_id, checkoutUuid);
		const quantity = decimal(item.quantity, 6);
		validQuantity(quantity, '0.000001');
		if (ids.has(product_id)) invalid();
		ids.add(product_id);
		return { product_id, quantity };
	});
	if (row.contact !== null && (typeof row.contact !== 'string' || !row.contact.trim()
		// eslint-disable-next-line no-control-regex -- rejects control characters other than tab and line breaks.
		|| [...row.contact].length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(row.contact))) return invalid();
	return { ...binding, items, contact: row.contact as string | null };
}

export function parsePrepareResponse(value: unknown): { checkout_id: string } {
	return { checkout_id: text(record(value).checkout_id, checkoutUuid) };
}
export function parseSessionResponse(value: unknown): { fingerprint: string } {
	return { fingerprint: text(record(value).fingerprint, fingerprintPattern) };
}

/** Pick reviewed fields only, so an upstream extension can never leak credentials. */
export function parseCheckoutSnapshot(value: unknown): CheckoutSnapshot {
	const row = record(value);
	const checkout_id = text(row.checkout_id, checkoutUuid);
	const created_at = timestamp(row.created_at);
	if (row.status !== 'unconfirmed' && row.status !== 'confirmed') return invalid();
	const confirmed_at = row.confirmed_at === null ? null : timestamp(row.confirmed_at);
	if (row.registration_method !== null && row.registration_method !== 'buyer'
		&& row.registration_method !== 'staff_recovery') return invalid();
	if ((row.status === 'confirmed') !== (confirmed_at !== null)
		|| (row.status === 'confirmed') !== (row.registration_method !== null)) return invalid();
	const total_nok = decimal(row.total_nok, 2);
	if (typeof row.payment_required !== 'boolean'
		|| row.payment_required !== (compareDecimals(total_nok, '0') > 0)) return invalid();
	if (row.contact_text !== null && (typeof row.contact_text !== 'string' || [...row.contact_text].length > 300)) return invalid();
	if (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > 200) return invalid();
	const ids = new Set<string>();
	const items = row.items.map((value) => {
		const item = record(value);
		const product_id = text(item.product_id, checkoutUuid);
		if (ids.has(product_id)) invalid();
		ids.add(product_id);
		const quantity = decimal(item.quantity, 6);
		validQuantity(quantity, '0.000001');
		const unit_price_nok = decimal(item.unit_price_nok, 6);
		if (compareDecimals(unit_price_nok, '999999999999') > 0) invalid();
		return {
			product_id, code: text(item.code, /^[A-Z0-9][A-Z0-9-]{0,39}$/),
			name_nb: name(item.name_nb), name_en: name(item.name_en),
			unit: text(item.unit, /^[a-z][a-z0-9_]{0,23}$/), quantity,
			unit_price_nok, line_total_nok: decimal(item.line_total_nok, 2)
		};
	});
	return { checkout_id, created_at, status: row.status, confirmed_at, total_nok,
		payment_required: row.payment_required, registration_method: row.registration_method,
		contact_text: row.contact_text as string | null, items };
}
