import type { AdminAuthConfig } from './admin-auth';
import { requestApiJson, object, text, identifier, uuidPattern, type Fetcher } from './api';
import { parseEditableHelpContact, type EditableHelpContact } from './help';

export type StaffSession = { config: AdminAuthConfig; token: string; userId: string };
/** A scalar filter consumes the entire value after eq.; quoting here is literal.
 * URLSearchParams handles transport escaping. List/logic expressions have a
 * different grammar and must not use this helper to interpolate their values. */
export function staffEquals(value: string | number | boolean | null): string {
	return value === null ? 'is.null' : `eq.${value}`;
}
export async function staffRequest(session: StaffSession, path: string, query: Record<string, string> = {}, body?: unknown, method = 'POST', fetcher: Fetcher = fetch): Promise<unknown> {
	const url = new URL(`/rest/v1/${path}`, session.config.url);
	url.search = new URLSearchParams(query).toString();
	return await requestApiJson(url, {
		method: body === undefined && method !== 'DELETE' ? 'GET' : method, credentials: 'omit', cache: 'no-store',
		headers: { apikey: session.config.publishableKey, Authorization: `Bearer ${session.token}`, Accept: 'application/json',
			Prefer: 'return=representation', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	}, fetcher);
}
function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error('Invalid staff rows');
	return value.map(object);
}
function single(value: unknown, optional = false): Record<string, unknown> | null {
	const list = rows(value);
	if (list.length > 1 || (!optional && list.length !== 1)) throw new Error('Invalid staff lookup');
	return list[0] ?? null;
}
function decimal(value: unknown, scale: number): string {
	if (typeof value !== 'string' || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(value)) throw new Error('Invalid staff decimal');
	return value;
}
function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid staff timestamp');
	return value;
}

/** Only one immutable UUID key, and every page continues through the empty response. */
async function allRows(session: StaffSession, view: string, select: string, key: string, filters: Record<string, string> = {}, fetcher: Fetcher = fetch) {
	const result: Record<string, unknown>[] = [];
	let after = '';
	for (;;) {
		const cursor: Record<string, string> = after ? { and: `(${key}.gt.${after}${filters.and ? `,and${filters.and}` : ''})` } : {};
		const page = rows(await staffRequest(session, view, { select, ...filters, order: `${key}.asc`, limit: '200', ...cursor }, undefined, 'POST', fetcher));
		if (page.length > 200) throw new Error('Invalid staff page');
		if (!page.length) return result;
		for (const row of page) {
			const id = identifier(row[key]);
			if (id <= after) throw new Error('Invalid staff cursor');
			after = id; result.push(row);
		}
	}
}
export { allRows as allStaffRows };
export type StaffCheckout = {
	id: string; requestId: string; createdAt: string; total: string;
	registered: boolean; eventId: string | null; registeredAt: string | null;
	items: { productId: string; name_nb: string; name_en: string; code: string; unit: string; quantity: string; unitPrice: string }[];
};
export async function readStaffCheckout(session: StaffSession, reference: string, fetcher: Fetcher = fetch): Promise<StaffCheckout | null> {
	if (!uuidPattern.test(reference)) throw new Error('Invalid checkout reference');
	const header = single(await staffRequest(session, 'amp_checkouts', { select: 'id,request_id,created_at', or: `(id.eq.${reference},request_id.eq.${reference})`, limit: '2' }, undefined, 'POST', fetcher), true);
	if (!header) return null;
	const id = identifier(header.id);
	const [lines, totalValue, saleValue] = await Promise.all([
		allRows(session, 'amp_checkout_lines', 'checkout_id,product_id,product_name_nb_snapshot,product_name_en_snapshot,quantity,unit_price_nok', 'product_id', { checkout_id: `eq.${id}` }, fetcher),
		staffRequest(session, 'amp_checkout_totals', { select: 'checkout_id,total_nok', checkout_id: `eq.${id}`, limit: '2' }, undefined, 'POST', fetcher),
		staffRequest(session, 'amp_sales', { select: 'checkout_id,event_id', checkout_id: `eq.${id}`, limit: '2' }, undefined, 'POST', fetcher)
	]);
	if (!lines.length || lines.length > 200) throw new Error('Invalid checkout lines');
	const total = single(totalValue)!;
	const sale = single(saleValue, true);
	if (total.checkout_id !== id || (sale && sale.checkout_id !== id)) throw new Error('Invalid checkout binding');
	// Product code and unit are immutable. Names and prices come only from the saved lines.
	const products = new Map<string, Record<string, unknown>>();
	let cursor = '';
	const ids = lines.map((line) => identifier(line.product_id));
	for (;;) {
		const page = rows(await staffRequest(session, 'amp_products', { select: 'id,code,unit_code', id: `in.(${ids.join(',')})`, order: 'id.asc', limit: '200', ...(cursor ? { and: `(id.gt.${cursor})` } : {}) }, undefined, 'POST', fetcher));
		if (!page.length) break;
		for (const product of page) {
			const productId = identifier(product.id);
			if (productId <= cursor || !ids.includes(productId)) throw new Error('Invalid checkout product cursor');
			products.set(productId, product); cursor = productId;
		}
	}
	let registeredAt: string | null = null;
	const eventId = sale ? identifier(sale.event_id) : null;
	if (eventId) {
		const event = single(await staffRequest(session, 'amp_inventory_events', { select: 'id,recorded_at', id: `eq.${eventId}`, limit: '2' }, undefined, 'POST', fetcher))!;
		if (event.id !== eventId) throw new Error('Invalid sale event');
		registeredAt = timestamp(event.recorded_at);
	}
	return { id, requestId: identifier(header.request_id), createdAt: timestamp(header.created_at), total: decimal(total.total_nok, 2), registered: Boolean(sale), eventId, registeredAt,
		items: lines.map((line) => {
			const productId = identifier(line.product_id);
			const product = products.get(productId);
			if (line.checkout_id !== id || !product) throw new Error('Incomplete checkout snapshot');
			return { productId, name_nb: text(line.product_name_nb_snapshot, 1000), name_en: text(line.product_name_en_snapshot, 1000), code: text(product.code, 40), unit: text(product.unit_code, 24), quantity: decimal(line.quantity, 6), unitPrice: decimal(line.unit_price_nok, 6) };
		}) };
}

export type RecoveryCommand = { userId: string; requestId: string; checkoutId: string; reason: string };
const recoveryKey = 'ampoteket:admin-recovery:v1';
export function readRecoveryCommand(storage: Pick<Storage, 'getItem'>): RecoveryCommand | null {
	const raw = storage.getItem(recoveryKey);
	if (!raw) return null;
	const row = object(JSON.parse(raw));
	return { userId: identifier(row.userId), requestId: identifier(row.requestId), checkoutId: identifier(row.checkoutId), reason: text(row.reason, 2000) };
}
export function saveRecoveryCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: RecoveryCommand): RecoveryCommand {
	const existing = readRecoveryCommand(storage);
	if (existing && JSON.stringify(existing) !== JSON.stringify(command)) throw new Error('Unresolved recovery command');
	storage.setItem(recoveryKey, JSON.stringify(command));
	const saved = readRecoveryCommand(storage);
	if (!saved || JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Recovery persistence unavailable');
	return saved;
}
export function clearRecoveryCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: RecoveryCommand): void {
	const saved = readRecoveryCommand(storage);
	if (saved?.requestId === command.requestId && saved.userId === command.userId) storage.removeItem(recoveryKey);
}
export async function recoverStaffCheckout(session: StaffSession, command: RecoveryCommand, fetcher: Fetcher = fetch): Promise<string> {
	if (session.userId !== command.userId) throw new Error('Recovery identity changed');
	const result = object(await staffRequest(session, 'rpc/amp_recover_checkout', {}, { p_request_id: command.requestId, p_checkout_id: command.checkoutId, p_reason: command.reason }, 'POST', fetcher));
	if (result.checkout_id !== command.checkoutId || result.status !== 'confirmed') throw new Error('Invalid recovery response');
	return identifier(result.event_id);
}
export async function readAdminHelp(session: StaffSession, fetcher: Fetcher = fetch): Promise<EditableHelpContact[]> {
	return (await allRows(session, 'amp_help_contacts', 'id,display_name,responsibility,email,phone,contact_url,discord,display_order,is_published,edit_revision', 'id', {}, fetcher)).map(parseEditableHelpContact)
		.sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));
}
/** `ids` is every contact, drafts included, in the new order; `STALE_HELP_ORDER` means re-read first. */
export async function reorderHelpContacts(session: StaffSession, ids: string[], fetcher: Fetcher = fetch) {
	await staffRequest(session, 'rpc/amp_reorder_help_contacts', {}, { p_ids: ids }, 'POST', fetcher);
}
