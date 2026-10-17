import { identifier, object, text } from './api';
import { api, errorCode, type StaffSession } from './convex';
import { compareDecimals, normalizeDecimal } from './decimal';
import { productName } from './catalog';
import { messagesFor, type Locale } from './i18n';

export type OrderProduct = { id: string; code: string; name_nb: string; name_en: string; unit_code: string; stock_step: string; minimum_stock: string; is_active: boolean; purchase_url: string | null };
export type Order = { id: string; requestId: string; supplierName: string; supplierReference: string | null; placedAt: string; additionalCostNok: string; note: string | null; createdBy: string; recordedAt: string; lineCount: number; openLineCount: number };
export type OrderLine = { id: string; orderId: string; lineNumber: number; productId: string; orderedQuantity: string; unitCostNok: string; purchaseUrl: string | null; supplierSku: string | null; receivedQuantity: string; cancelledQuantity: string; outstandingQuantity: string };
export type OrderCancellation = { id: string; requestId: string; orderLineId: string; quantity: string; reversesId: string | null; reason: string; createdBy: string; recordedAt: string };
export type OrderActor = { id: string; name: string };
export type ReceiptMovement = { id: string; eventId: string; productId: string; quantityDelta: string; orderLineId: string | null };
export type OrderReceipt = { id: string; requestId: string | null; kind: 'receipt' | 'adjustment'; actorId: string; purchaseOrderId: string | null; note: string | null; occurredAt: string; recordedAt: string; movements: ReceiptMovement[] };
export type OrderDetail = { order: Order | null; lines: OrderLine[]; products: OrderProduct[]; actors: OrderActor[]; cancellations: OrderCancellation[]; receipts: OrderReceipt[] };

export function orderProductName(product: OrderProduct | undefined, locale: Locale): string {
	return product ? productName(product, locale) : messagesFor(locale).adminOrders.unknownProduct;
}

export type OrderCommand = { userId: string; requestId: string } & (
	{ kind: 'create'; supplierName: string; placedAt: string; additionalCostNok: string; supplierReference: string | null; note: string | null; items: { productId: string; quantity: string; unitCostNok: string; purchaseUrl: string | null; supplierSku: string | null }[] }
	| { kind: 'receipt'; orderId: string | null; note: string | null; occurredAt: string | null; items: { productId: string; orderLineId: string | null; quantity: string }[] }
	| { kind: 'cancel'; orderId: string; reason: string; items: { orderLineId: string; quantity: string }[] }
	| { kind: 'reverse'; orderId: string; cancellationId: string; reason: string }
);
export type OrderCommandResult = { kind: 'create'; orderId: string } | { kind: 'receipt'; eventId: string } | { kind: 'cancel'; orderId: string } | { kind: 'reverse'; cancellationId: string; orderId: string };

function date(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid order timestamp');
	return value;
}
function decimal(value: unknown, scale = 6): string {
	if (typeof value !== 'string' || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(value) || compareDecimals(value, '999999999999') > 0) throw new Error('Invalid order decimal');
	return value;
}

/** Every product, including inactive ones, for choosing order lines. */
export async function readOrderProducts(session: StaffSession): Promise<OrderProduct[]> {
	return (await session.client.query(api.products.list, {}))
		.map(({ id, code, name_nb, name_en, unit_code, stock_step, minimum_stock, is_active, purchase_url }): OrderProduct => ({ id, code, name_nb, name_en, unit_code, stock_step, minimum_stock, is_active, purchase_url }))
		.sort((a, b) => a.code.localeCompare(b.code));
}
/** Quantity still expected from suppliers, summed per product over every open order line. */
export async function readOutstandingByProduct(session: StaffSession): Promise<Map<string, string>> {
	return new Map(Object.entries(await session.client.query(api.orders.outstandingByProduct, {})));
}
/** Open orders first, newest placement first within each group. */
export async function readOrders(session: StaffSession): Promise<Order[]> {
	return await session.client.query(api.orders.list, {});
}
export async function readOrderDetail(session: StaffSession, orderId: string): Promise<OrderDetail> {
	const detail = await session.client.query(api.orders.detail, { orderId: identifier(orderId) });
	return detail ?? { order: null, lines: [], products: [], actors: [], cancellations: [], receipts: [] };
}
/** Receipts without an order (donations, finds), newest first. */
export async function readUnplannedReceipts(session: StaffSession): Promise<OrderReceipt[]> {
	return await session.client.query(api.orders.unplannedReceipts, {});
}

export type OrderMetadata = Pick<Order, 'supplierName' | 'supplierReference' | 'placedAt' | 'additionalCostNok' | 'note'>;
export type OrderLineMetadata = Pick<OrderLine, 'unitCostNok' | 'purchaseUrl' | 'supplierSku'>;
/** Audited compare-and-set correction: 'stale' when the order no longer matches what the editor showed. */
export async function updateOrderMetadata(session: StaffSession, basis: Order, next: OrderMetadata): Promise<'saved' | 'stale'> {
	const { supplierName, supplierReference, placedAt, additionalCostNok, note } = basis;
	return await session.client.mutation(api.orders.updateOrder, { id: basis.id, expected: { supplierName, supplierReference, placedAt, additionalCostNok, note }, next });
}
export async function updateOrderLineMetadata(session: StaffSession, basis: OrderLine, next: OrderLineMetadata): Promise<'saved' | 'stale'> {
	const { unitCostNok, purchaseUrl, supplierSku } = basis;
	return await session.client.mutation(api.orders.updateOrderLine, { id: basis.id, expected: { unitCostNok, purchaseUrl, supplierSku }, next });
}
/** A rejected correction wrote nothing; anything else may have saved. */
export function metadataRejected(error: unknown): boolean {
	const code = errorCode(error);
	return code !== null && code !== 'STAFF_REQUIRED';
}

export const orderStorageKey = 'ampoteket:admin-order-command:v1';
export const orderStorageEvent = 'ampoteket:order-command';
type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function commandDecimal(value: unknown, scale = 6, positive = false): string {
	const result = decimal(value, scale);
	if (positive && compareDecimals(result, '0') <= 0) throw new Error('Invalid order quantity');
	return normalizeDecimal(result);
}
function commandNote(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || [...value].length > 2000) throw new Error('Invalid order note');
	return value;
}
function commandItems(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('Invalid order items');
	return value.map(object);
}
function parseCommand(value: unknown): OrderCommand {
	const r = object(value), identity = { userId: identifier(r.userId), requestId: identifier(r.requestId) };
	if (r.kind === 'create') return { ...identity, kind: 'create', supplierName: text(r.supplierName, 200), placedAt: date(r.placedAt), additionalCostNok: commandDecimal(r.additionalCostNok, 2), supplierReference: commandNote(r.supplierReference), note: commandNote(r.note), items: commandItems(r.items).map(item => ({ productId: identifier(item.productId), quantity: commandDecimal(item.quantity, 6, true), unitCostNok: commandDecimal(item.unitCostNok), purchaseUrl: commandNote(item.purchaseUrl), supplierSku: commandNote(item.supplierSku) })) };
	if (r.kind === 'receipt') {
		const orderId = r.orderId === null ? null : identifier(r.orderId), note = commandNote(r.note);
		if (orderId === null && !note?.trim()) throw new Error('Unplanned receipt requires source note');
		return { ...identity, kind: 'receipt', orderId, note, occurredAt: r.occurredAt === null ? null : date(r.occurredAt), items: commandItems(r.items).map(item => {
			const orderLineId = item.orderLineId === null ? null : identifier(item.orderLineId);
			if ((orderId === null) !== (orderLineId === null)) throw new Error('Invalid receipt order line');
			return { productId: identifier(item.productId), orderLineId, quantity: commandDecimal(item.quantity, 6, true) };
		}) };
	}
	if (r.kind === 'cancel') return { ...identity, kind: 'cancel', orderId: identifier(r.orderId), reason: text(r.reason, 2000), items: commandItems(r.items).map(item => ({ orderLineId: identifier(item.orderLineId), quantity: commandDecimal(item.quantity, 6, true) })) };
	if (r.kind === 'reverse') return { ...identity, kind: 'reverse', orderId: identifier(r.orderId), cancellationId: identifier(r.cancellationId), reason: text(r.reason, 2000) };
	throw new Error('Invalid order command');
}
export function readOrderCommand(storage: ReadStorage): OrderCommand | null {
	const raw = storage.getItem(orderStorageKey);
	return raw === null ? null : parseCommand(JSON.parse(raw));
}
export function saveOrderCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: OrderCommand): OrderCommand {
	const candidate = parseCommand(command), existing = readOrderCommand(storage);
	if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error('Unresolved order command');
	storage.setItem(orderStorageKey, JSON.stringify(candidate));
	const saved = readOrderCommand(storage);
	if (JSON.stringify(saved) !== JSON.stringify(candidate)) throw new Error('Order storage unavailable');
	return saved!;
}
export function clearOrderCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: OrderCommand): void {
	const saved = readOrderCommand(storage);
	if (saved && JSON.stringify(saved) !== JSON.stringify(parseCommand(command))) throw new Error('Order command changed');
	storage.removeItem(orderStorageKey);
	if (readOrderCommand(storage)) throw new Error('Order storage unavailable');
}
export function orderCommandPath(command: OrderCommand): string {
	command = parseCommand(command);
	return command.kind === 'create' || (command.kind === 'receipt' && command.orderId === null) ? '/admin/orders' : `/admin/orders/${command.orderId}`;
}
/** Lock only the persistence step; never hold it over the network request. */
export async function updateOrderStorage<T>(action: (storage: WriteStorage) => T): Promise<T> {
	if (!navigator.locks) throw new Error('Order storage coordination unavailable');
	return navigator.locks.request(orderStorageKey, () => {
		const result = action(localStorage);
		window.dispatchEvent(new Event(orderStorageEvent));
		return result;
	});
}
export async function runOrderCommand(session: StaffSession, command: OrderCommand): Promise<OrderCommandResult> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Order command identity changed');
	const { client } = session, { requestId } = command;
	if (command.kind === 'create') {
		const { supplierName, placedAt, additionalCostNok, supplierReference, note, items } = command;
		const result = await client.mutation(api.orders.recordOrder, { requestId, supplierName, placedAt, additionalCostNok, supplierReference, note, items });
		return { kind: 'create', orderId: identifier(result.order_id) };
	}
	if (command.kind === 'receipt') {
		const { orderId, note, occurredAt, items } = command;
		return { kind: 'receipt', eventId: identifier((await client.mutation(api.orders.recordReceipt, { requestId, orderId, note, occurredAt, items })).event_id) };
	}
	if (command.kind === 'cancel') {
		const { orderId, reason, items } = command;
		if ((await client.mutation(api.orders.cancelQuantities, { requestId, orderId, reason, items })).order_id !== orderId) throw new Error('Invalid cancellation result');
		return { kind: 'cancel', orderId };
	}
	const result = await client.mutation(api.orders.reverseCancellation, { requestId, cancellationId: command.cancellationId, reason: command.reason });
	if (result.order_id !== command.orderId) throw new Error('Invalid reversal result');
	return { kind: 'reverse', cancellationId: identifier(result.cancellation_id), orderId: command.orderId };
}
/**
 * Only a domain rejection proves the transaction rolled back, so only it may
 * release a frozen command. Unknown outcomes, lost access and a reused request
 * ID keep the command for an identical retry.
 */
export function orderRejection(error: unknown): 'stale' | 'invalid' | null {
	const code = errorCode(error);
	if (code === null || code === 'STAFF_REQUIRED' || code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT') return null;
	return ['RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY', 'INVALID_CANCELLATION_QUANTITY', 'RECEIPT_CORRECTION_OUT_OF_RANGE'].includes(code) ? 'stale' : 'invalid';
}
