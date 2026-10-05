import { ApiError, identifier, object, text, type Fetcher } from './api';
import { allStaffRows, staffRequest, type StaffSession } from './admin-api';
import { addDecimals, compareDecimals, normalizeDecimal } from './decimal';
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

const orderFields = 'id,request_id,supplier_name,supplier_reference,placed_at,additional_cost_nok,note,created_by,recorded_at';
const lineFields = 'id,order_id,line_number,product_id,ordered_quantity,unit_cost_nok,purchase_url,supplier_sku,received_quantity,cancelled_quantity,outstanding_quantity';
const productFields = 'id,code,name_nb,name_en,unit_code,stock_step,minimum_stock,is_active,purchase_url';
const cancellationFields = 'id,request_id,order_line_id,quantity,reverses_id,reason,created_by,recorded_at';
const eventFields = 'id,request_id,kind,actor_id,purchase_order_id,note,occurred_at,recorded_at';

function optionalString(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string') throw new Error('Invalid order text');
	return value;
}
function date(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid order timestamp');
	return value;
}
function decimal(value: unknown, scale = 6, signed = false, bounded = false): string {
	if (typeof value !== 'string' || !new RegExp(`^${signed ? '-?' : ''}\\d+(?:\\.\\d{1,${scale}})?$`).test(value)
		|| (bounded && compareDecimals(value, '999999999999') > 0)) throw new Error('Invalid order decimal');
	return value;
}
function money(value: unknown): string { return decimal(value, 2, false, true); }
function parseOrder(value: unknown): Order {
	const r = object(value);
	return { id: identifier(r.id), requestId: identifier(r.request_id), supplierName: text(r.supplier_name, 200), supplierReference: optionalString(r.supplier_reference),
		placedAt: date(r.placed_at), additionalCostNok: money(r.additional_cost_nok), note: optionalString(r.note), createdBy: identifier(r.created_by), recordedAt: date(r.recorded_at), lineCount: 0, openLineCount: 0 };
}
function parseLine(value: unknown): OrderLine {
	const r = object(value), number = Number(r.line_number);
	if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('Invalid order line number');
	return { id: identifier(r.id), orderId: identifier(r.order_id), lineNumber: number, productId: identifier(r.product_id), orderedQuantity: decimal(r.ordered_quantity, 6, false, true),
		unitCostNok: decimal(r.unit_cost_nok, 6, false, true), purchaseUrl: optionalString(r.purchase_url), supplierSku: optionalString(r.supplier_sku),
		receivedQuantity: decimal(r.received_quantity, 6, true), cancelledQuantity: decimal(r.cancelled_quantity), outstandingQuantity: decimal(r.outstanding_quantity) };
}
function parseProduct(value: unknown): OrderProduct {
	const r = object(value), code = text(r.code, 40), unit = text(r.unit_code, 24), step = decimal(r.stock_step);
	if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code) || !/^[a-z][a-z0-9_]{0,23}$/.test(unit) || compareDecimals(step, '0') <= 0 || typeof r.is_active !== 'boolean') throw new Error('Invalid order product');
	return { id: identifier(r.id), code, name_nb: text(r.name_nb, 200), name_en: text(r.name_en, 200), unit_code: unit, stock_step: step, minimum_stock: decimal(r.minimum_stock, 6, false, true), is_active: r.is_active, purchase_url: optionalString(r.purchase_url) };
}
function parseCancellation(value: unknown): OrderCancellation {
	const r = object(value);
	return { id: identifier(r.id), requestId: identifier(r.request_id), orderLineId: identifier(r.order_line_id), quantity: decimal(r.quantity, 6, false, true),
		reversesId: r.reverses_id === null ? null : identifier(r.reverses_id), reason: text(r.reason, 2000), createdBy: identifier(r.created_by), recordedAt: date(r.recorded_at) };
}
function parseEvent(value: unknown): OrderReceipt {
	const r = object(value);
	if (r.kind !== 'receipt' && r.kind !== 'adjustment') throw new Error('Invalid order receipt kind');
	return { id: identifier(r.id), requestId: r.request_id === null ? null : identifier(r.request_id), kind: r.kind, actorId: identifier(r.actor_id),
		purchaseOrderId: r.purchase_order_id === null ? null : identifier(r.purchase_order_id), note: optionalString(r.note), occurredAt: date(r.occurred_at), recordedAt: date(r.recorded_at), movements: [] };
}
function parseMovement(value: unknown): ReceiptMovement {
	const r = object(value);
	if (typeof r.id !== 'string' || !/^[1-9]\d*$/.test(r.id) || BigInt(r.id) > 9223372036854775807n) throw new Error('Invalid receipt movement ID');
	return { id: r.id, eventId: identifier(r.event_id), productId: identifier(r.product_id), quantityDelta: decimal(r.quantity_delta, 6, true), orderLineId: null };
}
function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error('Invalid order rows');
	return value.map(object);
}
function one(value: unknown): Record<string, unknown> | null {
	const result = rows(value);
	if (result.length > 1) throw new Error('Invalid order lookup');
	return result[0] ?? null;
}
function chunks<T>(values: T[], size = 100): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
	return result;
}
async function bigintRows(session: StaffSession, view: string, select: string, key: string, filters: Record<string, string>, fetcher: Fetcher): Promise<Record<string, unknown>[]> {
	const result: Record<string, unknown>[] = []; let after = 0n;
	for (;;) {
		const page = rows(await staffRequest(session, view, { select, ...filters, order: `${key}.asc`, limit: '200', ...(after ? { and: `(${key}.gt.${after})` } : {}) }, undefined, 'POST', fetcher));
		if (page.length > 200) throw new Error('Invalid receipt page');
		if (!page.length) return result;
		for (const row of page) {
			if (typeof row[key] !== 'string' || !/^[1-9]\d*$/.test(row[key]) || BigInt(row[key]) <= after) throw new Error('Invalid receipt cursor');
			after = BigInt(row[key]); result.push(row);
		}
	}
}

export async function readOrderProducts(session: StaffSession, fetcher: Fetcher = fetch): Promise<OrderProduct[]> {
	return (await allStaffRows(session, 'amp_products', productFields, 'id', {}, fetcher)).map(parseProduct).sort((a, b) => a.code.localeCompare(b.code));
}
// Quantity still expected from suppliers, summed per product over every open order line.
export async function readOutstandingByProduct(session: StaffSession, fetcher: Fetcher = fetch): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const row of await allStaffRows(session, 'amp_purchase_line_progress', 'id,product_id,outstanding_quantity', 'id', { outstanding_quantity: 'gt.0' }, fetcher)) {
		identifier(row.id); const productId = identifier(row.product_id);
		result.set(productId, addDecimals(result.get(productId) ?? '0', decimal(row.outstanding_quantity)));
	}
	return result;
}
export async function readOrders(session: StaffSession, fetcher: Fetcher = fetch): Promise<Order[]> {
	const [orders, progress] = await Promise.all([
		allStaffRows(session, 'amp_purchase_orders', orderFields, 'id', {}, fetcher),
		allStaffRows(session, 'amp_purchase_line_progress', 'id,order_id,outstanding_quantity', 'id', {}, fetcher)
	]);
	const result = orders.map(parseOrder), byId = new Map(result.map(order => [order.id, order]));
	for (const row of progress) {
		identifier(row.id); const order = byId.get(identifier(row.order_id));
		if (!order) throw new Error('Incomplete order list');
		order.lineCount++;
		if (compareDecimals(decimal(row.outstanding_quantity), '0') > 0) order.openLineCount++;
	}
	if (result.some(order => order.lineCount < 1)) throw new Error('Incomplete order lines');
	return result.sort((a, b) => Number(b.openLineCount > 0) - Number(a.openLineCount > 0) || b.placedAt.localeCompare(a.placedAt) || b.id.localeCompare(a.id));
}

async function readReceiptMovements(session: StaffSession, allocations: { movementId: string; orderLineId: string }[], fetcher: Fetcher): Promise<OrderReceipt[]> {
	if (!allocations.length) return [];
	const movements = new Map<string, ReceiptMovement>();
	for (const ids of chunks(allocations.map(a => a.movementId))) {
		const found = await bigintRows(session, 'amp_inventory_movements', 'id,event_id,product_id,quantity_delta', 'id', { id: `in.(${ids.join(',')})` }, fetcher);
		if (found.length !== ids.length) throw new Error('Incomplete receipt movements');
		for (const value of found) { const movement = parseMovement(value); if (!ids.includes(movement.id) || movements.has(movement.id)) throw new Error('Invalid receipt movement binding'); movements.set(movement.id, movement); }
	}
	for (const allocation of allocations) movements.get(allocation.movementId)!.orderLineId = allocation.orderLineId;
	const eventIds = [...new Set([...movements.values()].map(m => m.eventId))], events = new Map<string, OrderReceipt>();
	for (const ids of chunks(eventIds)) {
		const found = await allStaffRows(session, 'amp_inventory_events', eventFields, 'id', { id: `in.(${ids.join(',')})` }, fetcher);
		if (found.length !== ids.length) throw new Error('Incomplete receipt events');
		for (const value of found) { const event = parseEvent(value); if (!ids.includes(event.id) || events.has(event.id)) throw new Error('Invalid receipt event binding'); events.set(event.id, event); }
	}
	for (const movement of movements.values()) events.get(movement.eventId)!.movements.push(movement);
	return [...events.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
}

export async function readOrderDetail(session: StaffSession, orderId: string, fetcher: Fetcher = fetch): Promise<OrderDetail> {
	identifier(orderId);
	const raw = one(await staffRequest(session, 'amp_purchase_orders', { select: orderFields, id: `eq.${orderId}`, limit: '2' }, undefined, 'POST', fetcher));
	if (!raw) return { order: null, lines: [], products: [], actors: [], cancellations: [], receipts: [] };
	const order = parseOrder(raw);
	if (order.id !== orderId) throw new Error('Invalid order binding');
	const lines = (await allStaffRows(session, 'amp_purchase_line_progress', lineFields, 'id', { order_id: `eq.${orderId}` }, fetcher)).map(parseLine);
	if (!lines.length || lines.some(line => line.orderId !== orderId)) throw new Error('Incomplete order lines');
	order.lineCount = lines.length; order.openLineCount = lines.filter(line => compareDecimals(line.outstandingQuantity, '0') > 0).length;
	const productIds = [...new Set(lines.map(line => line.productId))], products: OrderProduct[] = [];
	for (const ids of chunks(productIds)) {
		const found = await allStaffRows(session, 'amp_products', productFields, 'id', { id: `in.(${ids.join(',')})` }, fetcher);
		for (const row of found) { const product = parseProduct(row); if (!ids.includes(product.id)) throw new Error('Invalid order product binding'); products.push(product); }
	}
	if (products.length !== productIds.length || new Set(products.map(p => p.id)).size !== productIds.length) throw new Error('Incomplete order products');
	const cancellations: OrderCancellation[] = [], allocations: { movementId: string; orderLineId: string }[] = [];
	for (const ids of chunks(lines.map(line => line.id))) {
		const filter = { order_line_id: `in.(${ids.join(',')})` };
		for (const row of await allStaffRows(session, 'amp_purchase_order_cancellations', cancellationFields, 'id', filter, fetcher)) {
			const cancellation = parseCancellation(row); if (!ids.includes(cancellation.orderLineId)) throw new Error('Invalid cancellation binding'); cancellations.push(cancellation);
		}
		for (const row of await bigintRows(session, 'amp_receipt_allocations', 'movement_id,order_line_id', 'movement_id', filter, fetcher)) {
			const movementId = String(row.movement_id), orderLineId = identifier(row.order_line_id);
			if (!/^[1-9]\d*$/.test(movementId) || !ids.includes(orderLineId)) throw new Error('Invalid receipt allocation');
			allocations.push({ movementId, orderLineId });
		}
	}
	const receipts = await readReceiptMovements(session, allocations, fetcher);
	for (const receipt of receipts) {
		if (receipt.kind === 'receipt' ? receipt.purchaseOrderId !== orderId : receipt.purchaseOrderId !== null) throw new Error('Invalid order receipt binding');
		for (const movement of receipt.movements) {
			const line = lines.find(line => line.id === movement.orderLineId);
			if (!line || line.productId !== movement.productId) throw new Error('Invalid receipt line binding');
		}
	}
	const actorIds = [...new Set([order.createdBy, ...cancellations.map(entry => entry.createdBy), ...receipts.map(entry => entry.actorId)])];
	const actors: OrderActor[] = [];
	for (const ids of chunks(actorIds)) {
		for (const row of await allStaffRows(session, 'amp_staff_members', 'id,display_name', 'id', { id: `in.(${ids.join(',')})` }, fetcher)) {
			const id = identifier(row.id);
			if (!ids.includes(id)) throw new Error('Invalid order actor binding');
			actors.push({ id, name: text(row.display_name, 120) });
		}
	}
	if (actors.length !== actorIds.length || new Set(actors.map(actor => actor.id)).size !== actorIds.length) throw new Error('Incomplete order actors');
	return { order, lines: lines.sort((a, b) => a.lineNumber - b.lineNumber), products, actors, cancellations: cancellations.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id)), receipts };
}

export async function readUnplannedReceipts(session: StaffSession, fetcher: Fetcher = fetch): Promise<OrderReceipt[]> {
	const events = (await allStaffRows(session, 'amp_inventory_events', eventFields, 'id', { kind: 'eq.receipt', purchase_order_id: 'is.null' }, fetcher)).map(parseEvent);
	const byId = new Map(events.map(event => [event.id, event]));
	for (const ids of chunks(events.map(event => event.id))) {
		for (const row of await bigintRows(session, 'amp_inventory_movements', 'id,event_id,product_id,quantity_delta', 'id', { event_id: `in.(${ids.join(',')})` }, fetcher)) {
			const movement = parseMovement(row), event = byId.get(movement.eventId);
			if (!event) throw new Error('Invalid unplanned receipt binding');
			event.movements.push(movement);
		}
	}
	if (events.some(event => event.kind !== 'receipt' || event.purchaseOrderId !== null || !event.movements.length)) throw new Error('Incomplete unplanned receipts');
	return events.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
}

export const orderStorageKey = 'ampoteket:admin-order-command:v1';
export const orderStorageEvent = 'ampoteket:order-command';
type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function commandDecimal(value: unknown, scale = 6, positive = false): string {
	const result = decimal(value, scale, false, true);
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
export async function runOrderCommand(session: StaffSession, command: OrderCommand, fetcher: Fetcher = fetch): Promise<OrderCommandResult> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Order command identity changed');
	let path: string; let body: Record<string, unknown>;
	if (command.kind === 'create') { path = 'amp_record_order'; body = { p_request_id: command.requestId, p_supplier_name: command.supplierName, p_placed_at: command.placedAt, p_items: command.items.map(item => ({ product_id: item.productId, quantity: item.quantity, unit_cost_nok: item.unitCostNok, purchase_url: item.purchaseUrl, supplier_sku: item.supplierSku })), p_additional_cost_nok: command.additionalCostNok, p_supplier_reference: command.supplierReference, p_note: command.note }; }
	else if (command.kind === 'receipt') { path = 'amp_record_receipt'; body = { p_request_id: command.requestId, p_items: command.items.map(item => ({ product_id: item.productId, order_line_id: item.orderLineId, quantity: item.quantity })), p_purchase_order_id: command.orderId, p_note: command.note, p_occurred_at: command.occurredAt }; }
	else if (command.kind === 'cancel') { path = 'amp_cancel_order_quantities'; body = { p_request_id: command.requestId, p_order_id: command.orderId, p_items: command.items.map(item => ({ order_line_id: item.orderLineId, quantity: item.quantity })), p_reason: command.reason }; }
	else { path = 'amp_reverse_cancellation'; body = { p_request_id: command.requestId, p_cancellation_id: command.cancellationId, p_reason: command.reason }; }
	const result = object(await staffRequest(session, `rpc/${path}`, {}, body, 'POST', fetcher));
	if (command.kind === 'create') return { kind: 'create', orderId: identifier(result.order_id) };
	if (command.kind === 'receipt') return { kind: 'receipt', eventId: identifier(result.event_id) };
	if (command.kind === 'cancel') { const orderId = identifier(result.order_id); if (orderId !== command.orderId) throw new Error('Invalid cancellation result'); return { kind: 'cancel', orderId }; }
	const cancellationId = identifier(result.cancellation_id), orderId = identifier(result.order_id);
	if (orderId !== command.orderId) throw new Error('Invalid reversal result');
	return { kind: 'reverse', cancellationId, orderId };
}
/** Release only definitely rolled-back commands; transport/auth failures stay frozen. */
export function orderRejection(error: unknown): 'stale' | 'invalid' | null {
	if (!(error instanceof ApiError) || ![400, 409, 422].includes(error.status)) return null;
	const message = error.body && typeof error.body === 'object' && 'message' in error.body ? String(error.body.message) : '';
	if (['RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY', 'INVALID_CANCELLATION_QUANTITY', 'RECEIPT_CORRECTION_OUT_OF_RANGE'].some(code => message.startsWith(code))) return 'stale';
	return 'invalid';
}
