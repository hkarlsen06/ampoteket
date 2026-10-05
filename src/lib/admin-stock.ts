import { ApiError, identifier, object, text, type Fetcher } from './api';
import { allStaffRows, staffRequest, type StaffSession } from './admin-api';
import { readCountInventory, type InventorySnapshot } from './admin-counts';
import { compareDecimals, normalizeDecimal, validQuantity } from './decimal';

export type StockProduct = { id: string; code: string; name_nb: string; name_en: string; unit_code: string; stock_step: string; minimum_stock: string; is_active: boolean };
export type StockMovement = { id: string; eventId: string; delta: string; kind: string; note: string | null; at: string; actor: string | null; corrects: string | null; orderLineId: string | null; orderId: string | null; received: string | null; outstanding: string | null };
export type StockCount = { eventId: string; revision: string; expected: string; quantity: string; at: string; actor: string | null; note: string | null };
export type StockDetail = { stock: InventorySnapshot; movements: StockMovement[]; counts: StockCount[] };
export type StockCommand = { userId: string; requestId: string; kind: 'withdraw' | 'adjust' | 'correct'; productId: string; quantity: string; reason: string; movementId: string | null; revision: string | null; counted: string | null };

const bigint = (value: unknown): string => {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid movement ID');
	return value;
};
const decimal = (value: unknown, signed = false): string => {
	if (typeof value !== 'string' || !(signed ? /^-?\d+(?:\.\d{1,6})?$/ : /^\d+(?:\.\d{1,6})?$/).test(value)) throw new Error('Invalid stock quantity');
	return value;
};
const date = (value: unknown): string => {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid stock date');
	return value;
};
const note = (value: unknown): string | null => {
	if (value === null) return null;
	if (typeof value !== 'string' || [...value].length > 2000) throw new Error('Invalid stock note');
	return value;
};
const rows = (value: unknown): Record<string, unknown>[] => {
	if (!Array.isArray(value)) throw new Error('Invalid stock rows');
	return value.map(object);
};
const chunks = <T>(values: T[], size = 100): T[][] => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

/** Numeric keyset traversal stays exact even when movement IDs exceed JS safe integers. */
async function allBigintRows(session: StaffSession, view: string, select: string, filter: Record<string, string>, fetcher: Fetcher, key = 'id') {
	const result: Record<string, unknown>[] = []; let after = 0n;
	for (;;) {
		const page = rows(await staffRequest(session, view, { select, ...filter, order: `${key}.asc`, limit: '200', ...(after ? { and: `(${key}.gt.${after})` } : {}) }, undefined, 'POST', fetcher));
		if (page.length > 200) throw new Error('Invalid stock page');
		if (!page.length) return result;
		for (const row of page) {
			const id = BigInt(bigint(row[key]));
			if (id <= after) throw new Error('Invalid stock cursor');
			after = id; result.push(row);
		}
	}
}

export async function readStockProducts(session: StaffSession, fetcher: Fetcher = fetch): Promise<StockProduct[]> {
	return (await allStaffRows(session, 'amp_products', 'id,code,name_nb,name_en,unit_code,stock_step,minimum_stock,is_active', 'id', {}, fetcher)).map(value => {
		const row = object(value), code = text(row.code, 40), unit = text(row.unit_code, 24), step = decimal(row.stock_step);
		if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code) || !/^[a-z][a-z0-9_]{0,23}$/.test(unit) || compareDecimals(step, '0') <= 0 || typeof row.is_active !== 'boolean') throw new Error('Invalid stock product');
		return { id: identifier(row.id), code, name_nb: text(row.name_nb, 200), name_en: text(row.name_en, 200), unit_code: unit, stock_step: step, minimum_stock: decimal(row.minimum_stock), is_active: row.is_active };
	}).sort((a, b) => a.code.localeCompare(b.code));
}

export async function readStockDetail(session: StaffSession, productId: string, fetcher: Fetcher = fetch): Promise<StockDetail> {
	identifier(productId);
	const [stock, movementRows, countRows] = await Promise.all([
		readCountInventory(session, productId, fetcher),
		allBigintRows(session, 'amp_inventory_movements', 'id,event_id,product_id,quantity_delta', { product_id: `eq.${productId}` }, fetcher),
		allStaffRows(session, 'amp_stock_counts', 'event_id,product_id,expected_revision,expected_quantity,counted_quantity', 'event_id', { product_id: `eq.${productId}` }, fetcher)
	]);
	const ids = movementRows.map(row => bigint(row.id));
	const eventIds = [...new Set([...movementRows.map(row => identifier(row.event_id)), ...countRows.map(row => identifier(row.event_id))])];
	const events = new Map<string, Record<string, unknown>>();
	for (const group of chunks(eventIds)) for (const row of await allStaffRows(session, 'amp_inventory_events', 'id,kind,note,recorded_at,actor_id', 'id', { id: `in.(${group.join(',')})` }, fetcher)) events.set(identifier(row.id), row);
	if (events.size !== eventIds.length) throw new Error('Incomplete stock events');
	const actorIds = [...new Set([...events.values()].filter(row => row.actor_id !== null).map(row => identifier(row.actor_id)))];
	const actors = new Map<string, string>();
	for (const group of chunks(actorIds)) for (const row of await allStaffRows(session, 'amp_staff_members', 'id,display_name', 'id', { id: `in.(${group.join(',')})` }, fetcher)) actors.set(identifier(row.id), text(row.display_name, 120));
	if (actors.size !== actorIds.length) throw new Error('Incomplete stock actors');
	const corrections = new Map<string, string>(), allocations = new Map<string, string>();
	for (const group of chunks(ids)) {
		for (const row of await allBigintRows(session, 'amp_movement_corrections', 'movement_id,corrects_movement_id', { movement_id: `in.(${group.join(',')})` }, fetcher, 'movement_id')) corrections.set(bigint(row.movement_id), bigint(row.corrects_movement_id));
		for (const row of await allBigintRows(session, 'amp_receipt_allocations', 'movement_id,order_line_id', { movement_id: `in.(${group.join(',')})` }, fetcher, 'movement_id')) allocations.set(bigint(row.movement_id), identifier(row.order_line_id));
	}
	const lines = new Map<string, Record<string, unknown>>();
	for (const group of chunks([...new Set(allocations.values())])) for (const row of await allStaffRows(session, 'amp_purchase_line_progress', 'id,order_id,received_quantity,outstanding_quantity', 'id', { id: `in.(${group.join(',')})` }, fetcher)) lines.set(identifier(row.id), row);
	if (lines.size !== new Set(allocations.values()).size) throw new Error('Incomplete receipt progress');
	const movements = movementRows.map((row): StockMovement => {
		const id = bigint(row.id), eventId = identifier(row.event_id), event = events.get(eventId);
		if (row.product_id !== productId || !event) throw new Error('Invalid stock movement binding');
		const lineId = allocations.get(id) ?? null, line = lineId ? lines.get(lineId) : null;
		const kind = event.kind;
		if (!['receipt', 'sale', 'count', 'adjustment', 'withdrawal'].includes(String(kind))) throw new Error('Invalid stock event kind');
		return { id, eventId, delta: decimal(row.quantity_delta, true), kind: kind as string, note: note(event.note), at: date(event.recorded_at), actor: event.actor_id === null ? null : actors.get(identifier(event.actor_id))!, corrects: corrections.get(id) ?? null,
			orderLineId: lineId, orderId: line ? identifier(line.order_id) : null, received: line ? decimal(line.received_quantity, true) : null, outstanding: line ? decimal(line.outstanding_quantity) : null };
	}).reverse();
	const counts = countRows.map(row => {
		const eventId = identifier(row.event_id), event = events.get(eventId);
		if (row.product_id !== productId || !event || event.kind !== 'count') throw new Error('Invalid stock count binding');
		if (typeof row.expected_revision !== 'string' || !/^(0|[1-9]\d*)$/.test(row.expected_revision)) throw new Error('Invalid stock count revision');
		return { eventId, revision: row.expected_revision, expected: decimal(row.expected_quantity, true), quantity: decimal(row.counted_quantity), at: date(event.recorded_at), actor: event.actor_id === null ? null : actors.get(identifier(event.actor_id))!, note: note(event.note) };
	});
	return { stock, movements, counts };
}

export function needsRecount(detail: StockDetail, movementId: string): boolean {
	const target = BigInt(bigint(movementId));
	return detail.counts.some(count => BigInt(count.revision) >= target);
}

export function stockQuantity(input: string, step: string, signed: boolean, locale: 'nb' | 'en'): string {
	const value = normalizeDecimal(input, locale);
	if (!signed) return validQuantity(value, step);
	if (compareDecimals(value, '0') === 0) throw new Error('Zero correction');
	validQuantity(value.startsWith('-') ? value.slice(1) : value, step);
	return value;
}

export const stockStorageKey = 'ampoteket:admin-stock-command:v1';
export const stockStorageEvent = 'ampoteket:stock-command';
export function parseStockCommand(value: unknown): StockCommand {
	const row = object(value), kind = row.kind;
	if (kind !== 'withdraw' && kind !== 'adjust' && kind !== 'correct') throw new Error('Invalid stock command kind');
	const reason = text(row.reason, 2000).trim(), quantity = decimal(row.quantity, kind !== 'withdraw');
	if (kind === 'withdraw' && compareDecimals(quantity, '0') <= 0 || kind !== 'withdraw' && compareDecimals(quantity, '0') === 0) throw new Error('Invalid stock command quantity');
	const movementId = row.movementId === null ? null : bigint(row.movementId);
	const revision = row.revision === null ? null : row.revision;
	if (kind === 'correct' ? !movementId || typeof revision !== 'string' || !/^(0|[1-9]\d*)$/.test(revision) : movementId !== null || revision !== null) throw new Error('Invalid stock command reference');
	const counted = row.counted === null ? null : decimal(row.counted);
	if (kind !== 'correct' && counted !== null) throw new Error('Invalid stock recount');
	return { userId: identifier(row.userId), requestId: identifier(row.requestId), kind, productId: identifier(row.productId), quantity, reason, movementId, revision: revision as string | null, counted };
}
export function readStockCommand(storage: Pick<Storage, 'getItem'>): StockCommand | null {
	const value = storage.getItem(stockStorageKey);
	return value === null ? null : parseStockCommand(JSON.parse(value));
}
export function saveStockCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: StockCommand): StockCommand {
	const next = parseStockCommand(command), previous = readStockCommand(storage);
	if (previous && JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('Unresolved stock command');
	storage.setItem(stockStorageKey, JSON.stringify(next));
	if (JSON.stringify(readStockCommand(storage)) !== JSON.stringify(next)) throw new Error('Stock storage unavailable');
	return next;
}
export function clearStockCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: StockCommand) {
	if (JSON.stringify(readStockCommand(storage)) !== JSON.stringify(parseStockCommand(command))) throw new Error('Stock command changed');
	storage.removeItem(stockStorageKey);
	if (readStockCommand(storage)) throw new Error('Stock storage unavailable');
}
export async function updateStockStorage<T>(action: (storage: Storage) => T): Promise<T> {
	if (!navigator.locks) throw new Error('Stock coordination unavailable');
	return navigator.locks.request(stockStorageKey, () => { const result = action(localStorage); window.dispatchEvent(new Event(stockStorageEvent)); return result; });
}
export async function runStockCommand(session: StaffSession, value: StockCommand, fetcher: Fetcher = fetch): Promise<string> {
	const command = parseStockCommand(value);
	if (command.userId !== session.userId) throw new Error('Stock command identity changed');
	const body = command.kind === 'withdraw'
		? { p_request_id: command.requestId, p_items: [{ product_id: command.productId, quantity: command.quantity }], p_reason: command.reason }
		: command.kind === 'adjust'
			? { p_request_id: command.requestId, p_items: [{ product_id: command.productId, quantity_delta: command.quantity }], p_reason: command.reason }
			: command.counted === null
				? { p_request_id: command.requestId, p_items: [{ product_id: command.productId, quantity_delta: command.quantity, corrects_movement_id: command.movementId, expected_revision: command.revision }], p_reason: command.reason }
				: { p_request_id: command.requestId, p_corrects_movement_id: command.movementId, p_expected_revision: command.revision, p_quantity_delta: command.quantity, p_counted_quantity: command.counted, p_reason: command.reason };
	const path = command.kind === 'withdraw' ? 'amp_withdraw_stock' : command.counted !== null ? 'amp_correct_movement_and_count' : 'amp_adjust_stock';
	const result = object(await staffRequest(session, `rpc/${path}`, {}, body, 'POST', fetcher));
	return identifier(command.counted !== null ? result.correction_event_id : result.event_id);
}
export function stockRejection(error: unknown): 'stale' | 'recount' | 'invalid' | null {
	if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object' || !('message' in error.body)) return null;
	const message = String(error.body.message);
	if (message === 'STALE_STOCK_CORRECTION' || message === 'STALE_STOCK_COUNT') return 'stale';
	if (message === 'CORRECTION_REQUIRES_RECOUNT') return 'recount';
	if (['REASON_REQUIRED', 'INVALID_QUANTITY_STEP', 'RECEIPT_CORRECTION_OUT_OF_RANGE', 'INVALID_CORRECTION_REFERENCE',
		'INVALID_WITHDRAWAL', 'NEGATIVE_PHYSICAL_COUNT', 'QUANTITY_REQUIRED', 'DUPLICATE_CORRECTION_REFERENCE'].includes(message)
		|| message.startsWith('CORRECTED_MOVEMENT_NOT_FOUND') || message.startsWith('PRODUCT_NOT_FOUND')) return 'invalid';
	return null;
}
