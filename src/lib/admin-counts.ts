import { ApiError } from './api';
import { allStaffRows, staffRequest, type StaffSession } from './admin-api';
import { addDecimals, compareDecimals, normalizeDecimal } from './decimal';
import { identifier, object, text, type Fetcher } from './api';

export type CountProduct = { id: string; code: string; name_nb: string; name_en: string; unit_code: string; stock_step: string };
export type CountProductChoice = CountProduct & { bin_id: string | null; is_active: boolean };
export type InventorySnapshot = { productId: string; quantity: string; revision: string; lastCountedAt: string | null };
export type CountOwner = { id: string; name: string; active: boolean; authUserId: string | null };
export type CountBatch = { id: string; ownerId: string; title: string; startedAt: string; finishedAt: string | null; finishedBy: string | null; finishReason: string | null };
export type CountObservation = { eventId: string; batchId: string; productId: string; expected: string; counted: string; revision: string; recordedAt: string; actorId: string; note: string | null };
type CommandIdentity = { userId: string; requestId: string };
export type CountCommand = CommandIdentity & (
	{ kind: 'start'; title: string }
	| { kind: 'count'; productId: string; batchId: string | null; revision: string; expected: string; quantity: string; note: string | null }
	| { kind: 'finish'; batchId: string }
	| { kind: 'close'; batchId: string; reason: string }
);
export type CountResult = { batchId: string | null; eventId: string | null; quantity: string | null; difference: string | null };

function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid count timestamp');
	return value;
}
function decimal(value: unknown, negative = false): string {
	if (typeof value !== 'string' || !(negative ? /^-?\d+(?:\.\d{1,6})?$/ : /^\d+(?:\.\d{1,6})?$/).test(value)) throw new Error('Invalid count quantity');
	return value;
}
function revision(value: unknown): string {
	if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid count revision');
	return value;
}
function optionalNote(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || [...value].length > 2000) throw new Error('Invalid count note');
	return value;
}
/** Counts include zero and accumulated balances larger than an ordinary command. */
export function validCountQuantity(input: string, step: string, locale: 'nb' | 'en' = 'en'): string {
	const value = normalizeDecimal(input, locale);
	decimal(value); decimal(step);
	if (compareDecimals(step, '0') <= 0) throw new Error('Invalid count step');
	const scale = (value: string) => BigInt(value.replace('.', '').padEnd(value.includes('.') ? value.indexOf('.') + 6 : value.length + 6, '0'));
	if (scale(value) % scale(step) !== 0n) throw new Error('Invalid count step');
	return value;
}
export function countDifference(counted: string, expected: string): string {
	return addDecimals(counted, expected.startsWith('-') ? expected.slice(1) : `-${expected}`);
}
export async function readCountInventory(session: StaffSession, productId: string, fetcher: Fetcher = fetch): Promise<InventorySnapshot> {
	identifier(productId);
	const values = await staffRequest(session, 'amp_inventory', { select: 'product_id,quantity,revision,last_counted_at', product_id: `eq.${productId}`, limit: '2' }, undefined, 'POST', fetcher);
	if (!Array.isArray(values) || values.length !== 1) throw new Error('Count inventory unavailable');
	const row = object(values[0]);
	if (row.product_id !== productId) throw new Error('Invalid count inventory binding');
	return { productId, quantity: decimal(row.quantity, true), revision: revision(row.revision), lastCountedAt: row.last_counted_at === null ? null : timestamp(row.last_counted_at) };
}
function parseBatch(value: unknown): CountBatch {
	const row = object(value);
	const finishedAt = row.finished_at === null ? null : timestamp(row.finished_at);
	const finishedBy = row.finished_by === null ? null : identifier(row.finished_by);
	const finishReason = row.finish_reason === null ? null : text(row.finish_reason, 2000);
	if ((finishedAt === null) !== (finishedBy === null) || (finishReason && !finishedAt)) throw new Error('Invalid batch closure');
	return { id: identifier(row.id), ownerId: identifier(row.owner_id), title: text(row.title, 200), startedAt: timestamp(row.started_at), finishedAt, finishedBy, finishReason };
}
const batchFields = 'id,owner_id,title,started_at,finished_at,finished_by,finish_reason';
function parseOwner(value: unknown): CountOwner {
	const row = object(value);
	if (typeof row.is_active !== 'boolean') throw new Error('Invalid count owner');
	return { id: identifier(row.id), name: text(row.display_name, 120), active: row.is_active, authUserId: row.auth_user_id === null ? null : identifier(row.auth_user_id) };
}
export async function readCountBatches(session: StaffSession, fetcher: Fetcher = fetch): Promise<{ batches: CountBatch[]; owners: CountOwner[] }> {
	const [batchRows, ownerRows] = await Promise.all([
		allStaffRows(session, 'amp_count_batches', batchFields, 'id', {}, fetcher),
		allStaffRows(session, 'amp_staff_members', 'id,auth_user_id,display_name,is_active', 'id', {}, fetcher)
	]);
	const owners = ownerRows.map(parseOwner);
	const batches = batchRows.map(parseBatch);
	if (batches.some((batch) => !owners.some((owner) => owner.id === batch.ownerId) || (batch.finishedBy && !owners.some((owner) => owner.id === batch.finishedBy)))) throw new Error('Incomplete count owners');
	return { batches: batches.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)), owners };
}
export function countBatchAccess(batch: CountBatch, owner: CountOwner, currentStaffId: string): 'finished' | 'owner' | 'other' | 'abandoned' {
	if (batch.ownerId !== owner.id) throw new Error('Invalid count owner binding');
	if (batch.finishedAt) return 'finished';
	if (batch.ownerId === currentStaffId) return 'owner';
	return !owner.active || !owner.authUserId ? 'abandoned' : 'other';
}
export async function readCountHistory(session: StaffSession, batchId: string, fetcher: Fetcher = fetch): Promise<CountObservation[]> {
	identifier(batchId);
	const rows = await allStaffRows(session, 'amp_stock_counts', 'event_id,batch_id,product_id,expected_quantity,counted_quantity,expected_revision', 'event_id', { batch_id: `eq.${batchId}` }, fetcher);
	const events = new Map<string, Record<string, unknown>>();
	for (let start = 0; start < rows.length; start += 100) {
		const ids = rows.slice(start, start + 100).map((row) => identifier(row.event_id));
		for (const event of await allStaffRows(session, 'amp_inventory_events', 'id,kind,recorded_at,actor_id,note', 'id', { id: `in.(${ids.join(',')})` }, fetcher)) {
			if (!ids.includes(identifier(event.id)) || event.kind !== 'count') throw new Error('Invalid count history event');
			events.set(identifier(event.id), event);
		}
	}
	return rows.map((row): CountObservation => {
		const eventId = identifier(row.event_id); const event = events.get(eventId);
		if (row.batch_id !== batchId || !event) throw new Error('Incomplete count history');
		return { eventId, batchId, productId: identifier(row.product_id), expected: decimal(row.expected_quantity, true), counted: decimal(row.counted_quantity), revision: revision(row.expected_revision), recordedAt: timestamp(event.recorded_at), actorId: identifier(event.actor_id), note: optionalNote(event.note) };
	}).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.eventId.localeCompare(a.eventId));
}

/** A detail page needs one batch and its actors, never the whole batch archive.
 * Only the active owner needs the complete, narrow product projection for search.
 * Finished/read-only batches fetch just products referenced by their history. */
export async function readCountDetail(session: StaffSession, batchId: string, currentStaffId: string, options: { fetcher?: Fetcher; productId?: string } = {}): Promise<{
	batch: CountBatch | null; owners: CountOwner[]; products: CountProductChoice[]; observations: CountObservation[];
}> {
	identifier(batchId); identifier(currentStaffId);
	const fetcher = options.fetcher ?? fetch;
	const [rows, observations] = await Promise.all([
		staffRequest(session, 'amp_count_batches', { select: batchFields, id: `eq.${batchId}`, limit: '2' }, undefined, 'POST', fetcher),
		readCountHistory(session, batchId, fetcher)
	]);
	if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid count batch lookup');
	if (!rows.length) {
		if (observations.length) throw new Error('Missing count batch');
		return { batch: null, owners: [], products: [], observations };
	}
	const batch = parseBatch(rows[0]);
	if (batch.id !== batchId) throw new Error('Invalid count batch binding');
	const ownerIds = [...new Set([batch.ownerId, ...(batch.finishedBy ? [batch.finishedBy] : []), ...observations.map(entry => entry.actorId)])];
	const owners: CountOwner[] = [];
	for (let start = 0; start < ownerIds.length; start += 100) {
		const ids = ownerIds.slice(start, start + 100);
		const rows = await allStaffRows(session, 'amp_staff_members', 'id,auth_user_id,display_name,is_active', 'id', { id: `in.(${ids.join(',')})` }, fetcher);
		for (const row of rows) {
			const owner = parseOwner(row);
			if (!ids.includes(owner.id)) throw new Error('Invalid count owner binding');
			owners.push(owner);
		}
	}
	if (owners.length !== ownerIds.length) throw new Error('Incomplete count owners');
	const owner = owners.find(owner => owner.id === batch.ownerId)!;
	const productIds = [...new Set([...observations.map(entry => entry.productId), ...(options.productId ? [identifier(options.productId)] : [])])];
	const filters: Record<string, string>[] = [];
	if (countBatchAccess(batch, owner, currentStaffId) === 'owner') filters.push({});
	else for (let start = 0; start < productIds.length; start += 100) filters.push({ id: `in.(${productIds.slice(start, start + 100).join(',')})` });
	const products: CountProductChoice[] = [];
	for (const filter of filters) {
		const rows = await allStaffRows(session, 'amp_products', 'id,code,name_nb,name_en,unit_code,stock_step,bin_id,is_active', 'id', filter, fetcher);
		for (const row of rows) {
			const id = identifier(row.id), code = text(row.code, 40), unit = text(row.unit_code, 24), step = decimal(row.stock_step);
			if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code) || !/^[a-z][a-z0-9_]{0,23}$/.test(unit)
				|| compareDecimals(step, '0') <= 0 || typeof row.is_active !== 'boolean'
				|| (filter.id && !productIds.includes(id))) throw new Error('Invalid count product');
			products.push({ id, code, name_nb: text(row.name_nb, 200), name_en: text(row.name_en, 200), unit_code: unit,
				stock_step: step, bin_id: row.bin_id === null ? null : identifier(row.bin_id), is_active: row.is_active });
		}
	}
	const found = new Set(products.map(product => product.id));
	if (found.size !== products.length || productIds.some(id => !found.has(id))) throw new Error('Incomplete count products');
	return { batch, owners, products, observations };
}

/** One unresolved count command across this browser; never replace its actor or observation. */
export const countStorageKey = 'ampoteket:admin-count-command:v1';
export const countStorageEvent = 'ampoteket:count-command';
type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function parseCommand(value: unknown): CountCommand {
	const row = object(value); const identity = { userId: identifier(row.userId), requestId: identifier(row.requestId) };
	if (row.kind === 'start') return { ...identity, kind: row.kind, title: text(row.title, 200) };
	if (row.kind === 'finish') return { ...identity, kind: row.kind, batchId: identifier(row.batchId) };
	if (row.kind === 'close') return { ...identity, kind: row.kind, batchId: identifier(row.batchId), reason: text(row.reason, 2000) };
	if (row.kind === 'count') return { ...identity, kind: row.kind, productId: identifier(row.productId), batchId: row.batchId === null ? null : identifier(row.batchId), revision: revision(row.revision), expected: decimal(row.expected, true), quantity: decimal(row.quantity), note: optionalNote(row.note) };
	throw new Error('Invalid count command');
}
export function readCountCommand(storage: ReadStorage): CountCommand | null {
	const raw = storage.getItem(countStorageKey);
	return raw === null ? null : parseCommand(JSON.parse(raw));
}
export function saveCountCommand(storage: Pick<Storage, 'getItem' | 'setItem'>, command: CountCommand): CountCommand {
	const candidate = parseCommand(command); const existing = readCountCommand(storage);
	if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error('Unresolved count command');
	storage.setItem(countStorageKey, JSON.stringify(candidate));
	const saved = readCountCommand(storage);
	if (JSON.stringify(saved) !== JSON.stringify(candidate)) throw new Error('Count storage unavailable');
	return saved!;
}
export function clearCountCommand(storage: Pick<Storage, 'getItem' | 'removeItem'>, command: CountCommand): void {
	const saved = readCountCommand(storage);
	if (saved && JSON.stringify(saved) !== JSON.stringify(parseCommand(command))) throw new Error('Count command changed');
	storage.removeItem(countStorageKey);
	if (readCountCommand(storage)) throw new Error('Count storage unavailable');
}
export function countCommandPath(command: CountCommand): string {
	return command.kind === 'count' && !command.batchId ? `/admin/products/${command.productId}` : command.kind === 'start' ? '/admin/counts' : `/admin/counts/${command.batchId}`;
}
/** Locks protect only persistence; no database/network request holds a browser lock. */
export async function updateCountStorage<T>(action: (storage: WriteStorage) => T): Promise<T> {
	if (!navigator.locks) throw new Error('Count storage coordination unavailable');
	return navigator.locks.request(countStorageKey, () => {
		const result = action(localStorage);
		window.dispatchEvent(new Event(countStorageEvent));
		return result;
	});
}
export async function runCountCommand(session: StaffSession, command: CountCommand, fetcher: Fetcher = fetch): Promise<CountResult> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Count command identity changed');
	let path: string; let body: Record<string, string | null>;
	if (command.kind === 'start') { path = 'amp_start_count_batch'; body = { p_request_id: command.requestId, p_title: command.title }; }
	else if (command.kind === 'finish') { path = 'amp_finish_count_batch'; body = { p_batch_id: command.batchId }; }
	else if (command.kind === 'close') { path = 'amp_close_abandoned_count_batch'; body = { p_request_id: command.requestId, p_batch_id: command.batchId, p_reason: command.reason }; }
	else {
		path = command.batchId ? 'amp_record_count' : 'amp_record_single_count';
		body = { p_request_id: command.requestId, p_product_id: command.productId, p_expected_revision: command.revision, p_counted_quantity: command.quantity, p_note: command.note, ...(command.batchId ? { p_batch_id: command.batchId } : {}) };
	}
	const result = object(await staffRequest(session, `rpc/${path}`, {}, body, 'POST', fetcher));
	if (command.kind !== 'count') {
		const batchId = identifier(result.batch_id);
		if (command.kind !== 'start' && (batchId !== command.batchId || result.finished !== true)) throw new Error('Invalid count closure result');
		return { batchId, eventId: null, quantity: null, difference: null };
	}
	const quantity = decimal(result.quantity); const difference = decimal(result.difference, true);
	if (compareDecimals(quantity, command.quantity) !== 0 || compareDecimals(difference, countDifference(command.quantity, command.expected)) !== 0) throw new Error('Invalid count result');
	return { batchId: command.batchId ?? identifier(result.batch_id), eventId: identifier(result.event_id), quantity, difference };
}
/** Only known transaction rejections release a frozen command. Network/shape/auth failures do not. */
export function countRejection(error: unknown): 'stale' | 'closed' | 'owner' | 'invalid' | null {
	if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object' || !('message' in error.body)) return null;
	const message = error.body.message;
	if (message === 'STALE_STOCK_COUNT') return 'stale';
	if (message === 'COUNT_BATCH_FINISHED') return 'closed';
	if (message === 'COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER' || message === 'COUNT_BATCH_OWNER_STILL_ACTIVE') return 'owner';
	if (['INVALID_QUANTITY_STEP', 'NEGATIVE_PHYSICAL_COUNT', 'CLOSURE_REASON_REQUIRED', 'PRODUCT_NOT_FOUND', 'COUNT_BATCH_NOT_FOUND'].includes(String(message))) return 'invalid';
	return null;
}
