import { expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { memory } from './test-storage';
import { rejection, type ConvexCaller, type StaffSession } from './convex';
import { parseAdminBin, parseAdminCabinet, readAdminShelf, shelfColumn, shelfInteger, saveShelfCommand, readShelfCommand,
	clearShelfCommand, executeShelfCommand, parseShelfCommand, shelfFailure, type AdminCabinet, type AdminBin, type ShelfCommand } from './admin-shelf';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
type Call = { name: string; args: Record<string, unknown> };
/** A ConvexCaller that records calls and answers by function name. */
function stub(handlers: Record<string, (args: Record<string, unknown>) => unknown>, calls: Call[] = []): ConvexCaller {
	const call = async (fn: never, args: Record<string, unknown>) => {
		const name = getFunctionName(fn); calls.push({ name, args });
		if (!handlers[name]) throw new Error(`Unexpected ${name}`);
		return handlers[name](args);
	};
	return { query: call, mutation: call, action: call } as unknown as ConvexCaller;
}
const userId = id(9);
const staff = (client: ConvexCaller): StaffSession => ({ client, userId });
const cabinet: AdminCabinet = { id: id(1), code: 'INTERNAL-1', label: null, outer_row: 1, outer_col: 1, inner_rows: 4, inner_cols: 12, is_archived: false };
const bin: AdminBin = { id: id(3), code: 'INTERNAL-BIN', label: null, cabinet_id: cabinet.id, inner_row: 1, inner_col: 1, row_span: 1, col_span: 2, is_archived: false };
const actor = { userId, requestId: id(10) };
test('storage parsing keeps archive nulls and accepts only bounded structural integers', () => {
	expect(parseAdminCabinet(cabinet)).toEqual(cabinet);
	expect(parseAdminBin(bin)).toEqual(bin);
	const archived = { ...bin, is_archived: true, cabinet_id: null, inner_row: null, inner_col: null };
	expect(parseAdminBin(archived)).toEqual(archived);
	expect(() => parseAdminBin({ ...bin, is_archived: true })).toThrow();
	expect(() => parseAdminCabinet({ ...cabinet, outer_row: null })).toThrow();
	for (const value of [0, -1, 1.5, 2147483648, '1']) expect(() => parseAdminBin({ ...bin, inner_row: value })).toThrow();
	for (const value of ['0', '-1', '1.1', '01', '2147483648', 1, null]) expect(() => shelfInteger(value)).toThrow();
	expect(shelfInteger('2147483647')).toBe(2147483647);
	expect(shelfColumn('AA')).toBe(27); expect(shelfColumn('c')).toBe(3);
	for (const value of ['', 'A1', ' A', 'ZZZZZZZZZZ']) expect(() => shelfColumn(value)).toThrow();
});
test('the shelf read includes archived storage and inactive assignments and marks occupied drawers', async () => {
	const secondCabinet = { ...cabinet, id: id(2), code: 'SECOND', outer_col: 2 };
	const archivedBin = { ...bin, id: id(4), code: 'ARCHIVED', is_archived: true, cabinet_id: null, inner_row: null, inner_col: null };
	const product = { id: id(5), code: 'RES-A0001', name_nb: 'Motstand', name_en: 'Resistor', bin_id: bin.id, is_active: false };
	const unplaced = { ...product, id: id(6), code: 'RES-A0002', bin_id: null, is_active: true };
	const source = { cabinets: [cabinet, secondCabinet], bins: [bin, archivedBin], products: [product, unplaced] };
	const result = await readAdminShelf(staff(stub({ 'shelf:admin': () => source })));
	expect(result.products[0].is_active).toBe(false); expect(result.products[0].bin_id).toBe(bin.id);
	expect(result.products[1]).toEqual(unplaced);
	expect(result.bins).toHaveLength(2);
	expect(result.live.cabinets).toHaveLength(2);
	expect(result.live.bins).toHaveLength(1);
	expect(result.live.bins[0].has_products).toBe(true);
	await expect(readAdminShelf(staff(stub({ 'shelf:admin': () => ({ ...source, bins: [bin, { ...archivedBin, code: bin.code }] }) })))).rejects.toThrow('Duplicate');
	await expect(readAdminShelf(staff(stub({ 'shelf:admin': () => ({ ...source, products: [{ ...product, bin_id: archivedBin.id }] }) })))).rejects.toThrow('Inconsistent');
});
test('saved storage commands preserve actor, exact original placement and request; conflicting replacement is refused', () => {
	const storage = memory(), command: ShelfCommand = { ...actor, kind: 'bin', before: bin, after: { ...bin, inner_col: 4 } };
	expect(saveShelfCommand(storage, command)).toEqual(command); expect(readShelfCommand(storage)).toEqual(command);
	expect(() => saveShelfCommand(storage, { ...command, after: { ...bin, inner_col: 5 } })).toThrow();
	expect(() => parseShelfCommand({ ...command, after: { ...command.after, id: id(7) } })).toThrow();
	expect(() => parseShelfCommand({ ...command, after: { ...command.after, code: 'CHANGED' } })).toThrow();
	expect(() => clearShelfCommand(storage, { ...command, userId: id(8) })).toThrow();
	clearShelfCommand(storage, command); expect(readShelfCommand(storage)).toBeNull();
	expect(() => saveShelfCommand({ ...storage, setItem: () => {} }, command)).toThrow();
});
test('a lost direct-move acknowledgement is resolved by resubmitting the same compare-and-set', async () => {
	const command: ShelfCommand = { ...actor, kind: 'bin', before: bin, after: { ...bin, inner_col: 4 } };
	let current = bin, writes = 0;
	const calls: Call[] = [];
	const client = stub({ 'shelf:updateBin': (args) => {
		// Field by field, like the backend's sameRow.
		const same = (a: object, b: unknown) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b as object).sort());
		if (same(current, args.after)) return 'saved';
		if (!same(current, args.before)) return 'stale';
		writes++; current = args.after as AdminBin; throw new TypeError('Lost response');
	} }, calls);
	await expect(executeShelfCommand(staff(client), command)).rejects.toThrow('Lost response');
	expect(await executeShelfCommand(staff(client), command)).toBe('saved'); expect(writes).toBe(1);
	expect(calls[0].args).toEqual(calls[1].args);
	expect(calls[0].args).toEqual({ before: bin, after: command.after });
	await expect(executeShelfCommand({ client, userId: id(8) }, command)).rejects.toThrow('identity');
	expect(calls).toHaveLength(2);
});
test('a stale direct move reports stale and is never resubmitted with refreshed guards', async () => {
	const command: ShelfCommand = { ...actor, kind: 'cabinet', before: cabinet, after: { ...cabinet, outer_col: 2 } };
	const calls: Call[] = [];
	expect(await executeShelfCommand(staff(stub({ 'shelf:updateCabinet': () => 'stale' }, calls)), command)).toBe('stale');
	expect(calls).toEqual([{ name: 'shelf:updateCabinet', args: { before: cabinet, after: command.after } }]);
});
test('atomic layout retries keep the original drawer identities, actor, snapshot and request after reload', async () => {
	const command: ShelfCommand = { ...actor, kind: 'layout', before: null, beforeBins: [], after: cabinet, bins: [bin] };
	const storage = memory(); saveShelfCommand(storage, command);
	const calls: Call[] = [];
	const client = stub({ 'shelf:saveLayout': () => {
		if (calls.length === 1) throw new TypeError('Lost reply');
		return { cabinet_id: cabinet.id, saved: true };
	} }, calls);
	await expect(executeShelfCommand(staff(client), command)).rejects.toThrow('Lost reply');
	const restored = readShelfCommand(storage)!;
	expect(await executeShelfCommand(staff(client), restored)).toBe('saved');
	expect(calls[0]).toEqual(calls[1]);
	expect(calls[1].args).toEqual({ requestId: actor.requestId, before: null, cabinet, beforeBins: [], bins: [bin] });
	await expect(executeShelfCommand({ client, userId: id(8) }, restored)).rejects.toThrow('identity');
	expect(calls).toHaveLength(2);
	await expect(executeShelfCommand(staff(stub({ 'shelf:saveLayout': () => ({ cabinet_id: id(99), saved: true }) })), command)).rejects.toThrow('acknowledgement');
	await expect(executeShelfCommand(staff(stub({ 'shelf:saveLayout': () => ({ cabinet_id: cabinet.id, saved: false }) })), command)).rejects.toThrow('acknowledgement');
});
test('cabinet archive retries the exact cabinet and drawer snapshot', async () => {
	const command: ShelfCommand = { ...actor, kind: 'archive-cabinet', before: cabinet, beforeBins: [bin] };
	const storage = memory(); saveShelfCommand(storage, command);
	const calls: Call[] = [];
	const client = stub({ 'shelf:archiveCabinet': () => {
		if (calls.length === 1) throw new TypeError('Lost archive reply');
		return { cabinet_id: cabinet.id, archived_bins: 1 };
	} }, calls);
	await expect(executeShelfCommand(staff(client), command)).rejects.toThrow('Lost archive reply');
	expect(await executeShelfCommand(staff(client), readShelfCommand(storage)!)).toBe('saved');
	expect(calls[1]).toEqual(calls[0]);
	expect(calls[0].args).toEqual({ requestId: actor.requestId, before: cabinet, beforeBins: [bin] });
	await expect(executeShelfCommand(staff(stub({ 'shelf:archiveCabinet': () => ({ cabinet_id: cabinet.id, archived_bins: 0 }) })), command)).rejects.toThrow('acknowledgement');
	expect(() => parseShelfCommand({ ...command, beforeBins: [{ ...bin, cabinet_id: id(2) }] })).toThrow();
});
test('layout commands reject invalid topology and preserve identities without individual creation paths', () => {
	const command: ShelfCommand = { ...actor, kind: 'layout', before: cabinet, beforeBins: [bin], after: cabinet, bins: [bin] };
	expect(parseShelfCommand(command)).toEqual(command);
	for (const changed of [
		{ ...command, bins: [bin, bin] },
		{ ...command, bins: [{ ...bin, cabinet_id: id(2) }] },
		{ ...command, bins: [{ ...bin, col_span: 13 }] },
		{ ...command, bins: [{ ...bin, code: 'REPLACED' }] },
		{ ...command, before: null },
		{ ...command, after: { ...cabinet, inner_rows: 4097 } },
		{ ...command, beforeBins: [bin, bin] },
		{ ...command, bins: [bin, { ...bin, id: id(4), code: 'OVERLAP' }] },
		{ ...actor, kind: 'cabinet', before: null, after: cabinet },
		{ ...actor, kind: 'bin', before: null, after: bin },
		{ ...actor, kind: 'bin', before: bin, after: { ...bin, col_span: 1 } }
	]) expect(() => parseShelfCommand(changed)).toThrow();
});
test('bin swaps keep original spans, actor and request through retries and validate destination acknowledgement', async () => {
	const second = { ...bin, id: id(4), code: 'SECOND', inner_col: 5, col_span: 1 };
	const command: ShelfCommand = { ...actor, kind: 'swap-bins', first: bin, second };
	const calls: Call[] = [];
	const client = stub({ 'shelf:swapBins': () => ({ first_bin_id: bin.id, first_cabinet_id: cabinet.id, first_inner_row: 1, first_inner_col: 5,
		second_bin_id: second.id, second_cabinet_id: cabinet.id, second_inner_row: 1, second_inner_col: 1 }) }, calls);
	expect(await executeShelfCommand(staff(client), command)).toBe('saved');
	expect(await executeShelfCommand(staff(client), command)).toBe('saved'); expect(calls[0]).toEqual(calls[1]);
	expect(calls[0].args).toEqual({ requestId: actor.requestId, first: bin, second });
	await expect(executeShelfCommand(staff(stub({ 'shelf:swapBins': () => ({}) })), command)).rejects.toThrow('acknowledgement');
	expect(() => parseShelfCommand({ ...command, second: bin })).toThrow();
});
test('cabinet swaps acknowledge the exchanged wall positions', async () => {
	const second = { ...cabinet, id: id(2), code: 'SECOND', outer_col: 3 };
	const command: ShelfCommand = { ...actor, kind: 'swap-cabinets', first: cabinet, second };
	const reply = { first_cabinet_id: cabinet.id, first_outer_row: 1, first_outer_col: 3, second_cabinet_id: second.id, second_outer_row: 1, second_outer_col: 1 };
	expect(await executeShelfCommand(staff(stub({ 'shelf:swapCabinets': () => reply })), command)).toBe('saved');
	await expect(executeShelfCommand(staff(stub({ 'shelf:swapCabinets': () => ({ ...reply, first_outer_col: 1 }) })), command)).rejects.toThrow('acknowledgement');
});
test('shelf failures distinguish definite physical conflicts from unknown outcomes', () => {
	expect(shelfFailure(rejection('BIN_STILL_HAS_PRODUCTS'))).toBe('notEmpty');
	expect(shelfFailure(rejection('STALE_BIN_POSITION'))).toBe('stale');
	expect(shelfFailure(rejection('STALE_SHELF_LAYOUT'))).toBe('stale');
	expect(shelfFailure(rejection('LAYOUT_HAS_PRODUCTS'))).toBe('notEmpty');
	expect(shelfFailure(rejection('INVALID_SHELF_LAYOUT'))).toBe('invalid');
	expect(shelfFailure(rejection('CABINET_POSITION_OCCUPIED'))).toBe('occupied');
	expect(shelfFailure(rejection('BIN_DOES_NOT_FIT_CABINET_GRID'))).toBe('fit');
	expect(shelfFailure(new Error('BIN_STILL_HAS_PRODUCTS'))).toBeNull();
	expect(shelfFailure(new TypeError('Network'))).toBeNull();
	expect(shelfFailure(rejection('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'))).toBeNull();
	expect(shelfFailure(rejection('STAFF_REQUIRED'))).toBeNull();
});
