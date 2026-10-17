import { identifier, object, text } from './api';
import { api, errorCode, type StaffSession } from './convex';
import type { InventorySnapshot } from './admin-counts';
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

export async function readStockProducts(session: StaffSession): Promise<StockProduct[]> {
	return (await session.client.query(api.products.list, {}))
		.map(({ id, code, name_nb, name_en, unit_code, stock_step, minimum_stock, is_active }): StockProduct => ({ id, code, name_nb, name_en, unit_code, stock_step, minimum_stock, is_active }))
		.sort((a, b) => a.code.localeCompare(b.code));
}

/** One product's balance, movements (newest first) with correction and order links, and counts. */
export async function readStockDetail(session: StaffSession, productId: string): Promise<StockDetail> {
	return await session.client.query(api.stock.detail, { productId: identifier(productId) });
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
export async function runStockCommand(session: StaffSession, value: StockCommand): Promise<string> {
	const command = parseStockCommand(value);
	if (command.userId !== session.userId) throw new Error('Stock command identity changed');
	const { client } = session, { requestId, productId, quantity, reason } = command;
	if (command.kind === 'withdraw') return identifier((await client.mutation(api.stock.withdraw, { requestId, items: [{ productId, quantity }], reason })).event_id);
	if (command.kind === 'adjust') return identifier((await client.mutation(api.stock.adjust, { requestId, items: [{ productId, quantityDelta: quantity }], reason })).event_id);
	const correctsMovementId = command.movementId!, expectedRevision = command.revision!;
	// A later count already absorbed the mistake: correct and recount in one transaction.
	if (command.counted !== null) {
		const result = await client.mutation(api.stock.correctAndCount, { requestId, correctsMovementId, expectedRevision, quantityDelta: quantity, counted: command.counted, reason });
		return identifier(result.correction_event_id);
	}
	return identifier((await client.mutation(api.stock.adjust, { requestId, items: [{ productId, quantityDelta: quantity, correctsMovementId, expectedRevision }], reason })).event_id);
}
/** Only a domain rejection proves the command rolled back and may release it. */
export function stockRejection(error: unknown): 'stale' | 'recount' | 'invalid' | null {
	const code = errorCode(error);
	if (code === 'STALE_STOCK_CORRECTION' || code === 'STALE_STOCK_COUNT') return 'stale';
	if (code === 'CORRECTION_REQUIRES_RECOUNT') return 'recount';
	if (code !== null && ['REASON_REQUIRED', 'INVALID_QUANTITY_STEP', 'RECEIPT_CORRECTION_OUT_OF_RANGE', 'INVALID_CORRECTION_REFERENCE', 'INVALID_WITHDRAWAL',
		'NEGATIVE_PHYSICAL_COUNT', 'QUANTITY_REQUIRED', 'DUPLICATE_CORRECTION_REFERENCE', 'CORRECTED_MOVEMENT_NOT_FOUND', 'PRODUCT_NOT_FOUND'].includes(code)) return 'invalid';
	return null;
}
