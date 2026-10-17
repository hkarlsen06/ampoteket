import { identifier, object, text } from './api';
import { api, errorCode, type StaffSession } from './convex';
import { addDecimals, compareDecimals, normalizeDecimal } from './decimal';
import { formatDecimal } from './format';
import type { Locale } from './i18n';

export type CountProduct = { id: string; code: string; name_nb: string; name_en: string; unit_code: string; stock_step: string };
export type CountProductChoice = CountProduct & { bin_id: string | null; is_active: boolean };
export type InventorySnapshot = { productId: string; quantity: string; revision: string; lastCountedAt: string | null };
export type CountOwner = { id: string; name: string; active: boolean; authUserId: string | null };
/** `productId` marks a single-product count; its `title` is then just the product code, worded by the page. */
export type CountBatch = { id: string; ownerId: string; title: string; productId: string | null; startedAt: string; finishedAt: string | null; finishedBy: string | null; finishReason: string | null };
export type CountObservation = { eventId: string; batchId: string; productId: string; expected: string; counted: string; revision: string; recordedAt: string; actorId: string; note: string | null };
type CommandIdentity = { userId: string; requestId: string };
export type CountCommand = CommandIdentity & (
	{ kind: 'start'; title: string }
	| { kind: 'count'; productId: string; batchId: string | null; revision: string; expected: string; quantity: string; note: string | null }
	| { kind: 'finish'; batchId: string }
	| { kind: 'close'; batchId: string; reason: string }
);
export type CountResult = { batchId: string | null; eventId: string | null; quantity: string | null; difference: string | null };

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
/** A difference with an explicit sign, so a surplus and a shortage differ without colour. */
export function formatSignedDifference(difference: string, locale: Locale): string {
	return (compareDecimals(difference, '0') > 0 ? '+' : '') + formatDecimal(difference, locale);
}
/** The recorded balance and the revision a count is taken against. */
export async function readCountInventory(session: StaffSession, productId: string): Promise<InventorySnapshot> {
	const rows = await session.client.query(api.stock.inventory, { productIds: [identifier(productId)] });
	if (rows.length !== 1 || rows[0].product_id !== productId) throw new Error('Count inventory unavailable');
	const { quantity, revision, last_counted_at } = rows[0];
	return { productId, quantity, revision: String(revision), lastCountedAt: last_counted_at };
}
/** An owner row that cannot be read is never treated as abandoned: only a known, lost owner can be closed over. */
export function countBatchAccess(batch: CountBatch, owner: CountOwner | undefined, currentStaffId: string): 'finished' | 'owner' | 'other' | 'abandoned' {
	if (owner && batch.ownerId !== owner.id) throw new Error('Invalid count owner binding');
	if (batch.finishedAt) return 'finished';
	if (batch.ownerId === currentStaffId) return 'owner';
	return owner && (!owner.active || !owner.authUserId) ? 'abandoned' : 'other';
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
export async function runCountCommand(session: StaffSession, command: CountCommand): Promise<CountResult> {
	command = parseCommand(command);
	if (session.userId !== command.userId) throw new Error('Count command identity changed');
	const { client } = session, { requestId } = command;
	if (command.kind === 'start') {
		const result = await client.mutation(api.stock.startCountBatch, { requestId, title: command.title });
		return { batchId: identifier(result.batch_id), eventId: null, quantity: null, difference: null };
	}
	if (command.kind !== 'count') {
		const result = command.kind === 'finish'
			? await client.mutation(api.stock.finishCountBatch, { batchId: command.batchId })
			: await client.mutation(api.stock.closeAbandonedCountBatch, { requestId, batchId: command.batchId, reason: command.reason });
		if (result.batch_id !== command.batchId || result.finished !== true) throw new Error('Invalid count closure result');
		return { batchId: command.batchId, eventId: null, quantity: null, difference: null };
	}
	const observation = { requestId, productId: command.productId, expectedRevision: command.revision, counted: command.quantity, note: command.note };
	const result = command.batchId
		? await client.mutation(api.stock.recordCount, { ...observation, batchId: command.batchId })
		: await client.mutation(api.stock.recordSingleCount, observation);
	const quantity = decimal(result.quantity), difference = decimal(result.difference, true);
	if (compareDecimals(quantity, command.quantity) !== 0 || compareDecimals(difference, countDifference(command.quantity, command.expected)) !== 0) throw new Error('Invalid count result');
	return { batchId: command.batchId ?? identifier(result.batch_id), eventId: identifier(result.event_id), quantity, difference };
}
/**
 * Only a domain rejection proves the transaction rolled back, so only these
 * release a frozen count. Unknown outcomes, lost access and a reused request ID do not.
 */
export function countRejection(error: unknown): 'stale' | 'closed' | 'owner' | 'invalid' | null {
	const code = errorCode(error);
	if (code === 'STALE_STOCK_COUNT') return 'stale';
	if (code === 'COUNT_BATCH_FINISHED') return 'closed';
	if (code === 'COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER' || code === 'COUNT_BATCH_OWNER_STILL_ACTIVE') return 'owner';
	if (code !== null && ['INVALID_QUANTITY_STEP', 'NEGATIVE_PHYSICAL_COUNT', 'CLOSURE_REASON_REQUIRED', 'PRODUCT_NOT_FOUND', 'COUNT_BATCH_NOT_FOUND'].includes(code)) return 'invalid';
	return null;
}
