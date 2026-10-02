import { expect, test } from 'bun:test';
import { memory } from './test-storage';
import { ApiError, parseApiJson } from './api';
import { parseAdminBin, parseAdminCabinet, readAdminShelf, shelfColumn, shelfInteger, saveShelfCommand, readShelfCommand,
	clearShelfCommand, executeShelfCommand, parseShelfCommand, shelfFailure, type AdminCabinet, type AdminBin, type ShelfCommand } from './admin-shelf';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const session = { config: { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' }, token: 'staff-token', userId: id(9) };
const cabinet: AdminCabinet = { id: id(1), code: 'INTERNAL-1', label: null, outer_row: 1, outer_col: 1, inner_rows: 4, inner_cols: 12, is_archived: false };
const bin: AdminBin = { id: id(3), code: 'INTERNAL-BIN', label: null, cabinet_id: cabinet.id, inner_row: 1, inner_col: 1, row_span: 1, col_span: 2, is_archived: false };
const actor = { userId: session.userId, requestId: id(10) };
const wire = (value: unknown) => parseApiJson(JSON.stringify(value));
test('storage response parsing keeps archive nulls and accepts only bounded structural integers', () => {
	expect(parseAdminCabinet(wire(cabinet))).toEqual(cabinet);
	expect(parseAdminBin(wire(bin))).toEqual(bin);
	const archived = { ...bin, is_archived: true, cabinet_id: null, inner_row: null, inner_col: null };
	expect(parseAdminBin(wire(archived))).toEqual(archived);
	expect(() => parseAdminBin(wire({ ...bin, is_archived: true }))).toThrow();
	expect(() => parseAdminCabinet(wire({ ...cabinet, outer_row: null }))).toThrow();
	for (const value of ['0', '-1', '1.1', '01', '2147483648', 1, null]) expect(() => shelfInteger(value)).toThrow();
	expect(shelfInteger('2147483647')).toBe(2147483647);
	expect(shelfColumn('AA')).toBe(27); expect(shelfColumn('c')).toBe(3);
	for (const value of ['', 'A1', ' A', 'ZZZZZZZZZZ']) expect(() => shelfColumn(value)).toThrow();
});
test('complete shelf reads follow short capped pages and include inactive assignments', async () => {
	const pages = new Map<string, number>(), secondCabinet = { ...cabinet, id: id(2), code: 'SECOND', outer_col: 2 };
	const archivedBin = { ...bin, id: id(4), code: 'ARCHIVED', is_archived: true, cabinet_id: null, inner_row: null, inner_col: null };
	const product = { id: id(5), code: 'RES-A0001', name_nb: 'Motstand', name_en: 'Resistor', bin_id: bin.id, is_active: false };
	const unplaced = { ...product, id: id(6), code: 'RES-A0002', bin_id: null, is_active: true };
	const origin = { bin_id: archivedBin.id, cabinet_id: cabinet.id, cabinet_code: cabinet.code, cabinet_label: null,
		cabinet_outer_row: 1, cabinet_outer_col: 1, inner_row: 2, inner_col: 3, row_span: 1, col_span: 1 };
	const source: Record<string, unknown[]> = { amp_cabinets: [cabinet, secondCabinet], amp_bins: [bin, archivedBin], amp_products: [product, unplaced], amp_archived_bin_locations: [origin] };
	const result = await readAdminShelf(session, async (input, init) => {
		const url = new URL(String(input)), view = url.pathname.split('/').at(-1)!;
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-token');
		expect(url.searchParams.has('is_active')).toBe(false);
		const page = pages.get(view) ?? 0; pages.set(view, page + 1);
		if (page) {
			const key = view === 'amp_archived_bin_locations' ? 'bin_id' : 'id';
			expect(url.searchParams.get('and')).toBe(`(${key}.gt.${(source[view][page - 1] as Record<string, string>)[key]})`);
		}
		return Response.json(source[view].slice(page, page + 1));
	});
	expect(result.products[0].is_active).toBe(false); expect(result.products[0].bin_id).toBe(bin.id);
	expect(result.products[1]).toEqual(unplaced);
	expect(result.live.cabinets).toHaveLength(2);
	expect(result.live.bins[0].has_products).toBe(true);
	expect(result.archivedLocations.get(archivedBin.id)).toEqual({ binId: archivedBin.id, cabinetId: cabinet.id, cabinetCode: cabinet.code, cabinetLabel: null,
		cabinetOuterRow: 1, cabinetOuterCol: 1, innerRow: 2, innerCol: 3, rowSpan: 1, colSpan: 1 });
	expect([...pages.entries()].sort()).toEqual([['amp_archived_bin_locations', 2], ['amp_bins', 3], ['amp_cabinets', 3], ['amp_products', 3]]);
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
test('a lost direct-move acknowledgement is resolved by full readback without another write', async () => {
	const command: ShelfCommand = { ...actor, kind: 'bin', before: bin, after: { ...bin, inner_col: 4 } };
	let current = bin, writes = 0;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (init?.method === 'GET') return Response.json([current]);
		writes++;
		expect(url.searchParams.get('inner_col')).toBe('eq.1'); expect(url.searchParams.get('col_span')).toBe('eq.2');
		expect(url.searchParams.get('cabinet_id')).toBe(`eq.${cabinet.id}`);
		current = command.after; throw new TypeError('Lost response');
	};
	await expect(executeShelfCommand(session, command, fetcher)).rejects.toThrow('Lost response');
	expect(await executeShelfCommand(session, command, fetcher)).toBe('saved'); expect(writes).toBe(1);
	await expect(executeShelfCommand({ ...session, userId: id(8) }, command, fetcher)).rejects.toThrow('identity');
	expect(writes).toBe(1);
});
test('stale displayed spans and empty guarded PATCH results never refresh and resubmit', async () => {
	const command: ShelfCommand = { ...actor, kind: 'bin', before: bin, after: { ...bin, inner_col: 4 } };
	let writes = 0;
	expect(await executeShelfCommand(session, command, async (_input, init) => {
		if (init?.method !== 'GET') writes++;
		return Response.json([{ ...bin, col_span: 3 }]);
	})).toBe('stale');
	expect(writes).toBe(0);
	expect(await executeShelfCommand(session, command, async (_input, init) => {
		if (init?.method === 'GET') return Response.json([bin]);
		writes++; return Response.json([]);
	})).toBe('stale'); expect(writes).toBe(1);
});
test('scalar equality filters retain literal punctuation and returned records must match the entire target', async () => {
	const original = { ...cabinet, label: 'Left, right. ("test") \\ spare' };
	const command: ShelfCommand = { ...actor, kind: 'cabinet', before: original, after: { ...original, outer_col: 2 } };
	await expect(executeShelfCommand(session, command, async (input, init) => {
		if (init?.method === 'GET') return Response.json([original]);
		const url = new URL(String(input));
		expect(url.searchParams.get('label')).toBe(`eq.${original.label}`);
		return Response.json([{ ...command.after, inner_rows: 9 }]);
	})).rejects.toThrow('acknowledgement');
});
test('atomic layout retries keep the original drawer identities, actor, snapshot and request after reload', async () => {
	const command: ShelfCommand = { ...actor, kind: 'layout', before: null, beforeBins: [], after: cabinet, bins: [bin] };
	const storage = memory(); saveShelfCommand(storage, command);
	const requests: string[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_save_shelf_layout');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer staff-token');
		requests.push(String(init?.body));
		if (requests.length === 1) throw new TypeError('Lost reply');
		return Response.json({ cabinet_id: cabinet.id, saved: true });
	};
	await expect(executeShelfCommand(session, command, fetcher)).rejects.toThrow('Lost reply');
	const restored = readShelfCommand(storage)!;
	expect(await executeShelfCommand(session, restored, fetcher)).toBe('saved');
	expect(requests[0]).toBe(requests[1]);
	expect(JSON.parse(requests[1])).toEqual({ p_request_id: actor.requestId, p_before: null, p_cabinet: cabinet, p_before_bins: [], p_bins: [bin] });
	await expect(executeShelfCommand({ ...session, userId: id(8) }, restored, fetcher)).rejects.toThrow('identity');
	expect(requests).toHaveLength(2);
	await expect(executeShelfCommand(session, command, async () => Response.json({ cabinet_id: id(99), saved: true }))).rejects.toThrow('acknowledgement');
	await expect(executeShelfCommand(session, command, async () => Response.json({ cabinet_id: cabinet.id, saved: false }))).rejects.toThrow('acknowledgement');
});
test('cabinet archive retries the exact cabinet and drawer snapshot', async () => {
	const command: ShelfCommand = { ...actor, kind: 'archive-cabinet', before: cabinet, beforeBins: [bin] };
	const storage = memory(); saveShelfCommand(storage, command);
	const requests: string[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_archive_empty_cabinet');
		requests.push(String(init?.body));
		if (requests.length === 1) throw new TypeError('Lost archive reply');
		return Response.json({ cabinet_id: cabinet.id, archived_bins: 1 });
	};
	await expect(executeShelfCommand(session, command, fetcher)).rejects.toThrow('Lost archive reply');
	expect(await executeShelfCommand(session, readShelfCommand(storage)!, fetcher)).toBe('saved');
	expect(requests).toEqual([requests[0], requests[0]]);
	expect(JSON.parse(requests[0])).toEqual({ p_request_id: actor.requestId, p_before: cabinet, p_before_bins: [bin] });
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
test('bin swaps keep original spans, actor and UUID through retries and validate destination acknowledgement', async () => {
	const second = { ...bin, id: id(4), code: 'SECOND', inner_col: 5, col_span: 1 };
	const command: ShelfCommand = { ...actor, kind: 'swap-bins', first: bin, second };
	const payloads: unknown[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/amp_swap_bins');
		const payload = JSON.parse(String(init?.body)); payloads.push(payload);
		expect(payload.p_expected_first_col_span).toBe(2); expect(payload.p_expected_second_col_span).toBe(1);
		expect(payload.p_request_id).toBe(actor.requestId);
		return Response.json({ first_bin_id: bin.id, first_cabinet_id: cabinet.id, first_inner_row: 1, first_inner_col: 5,
			second_bin_id: second.id, second_cabinet_id: cabinet.id, second_inner_row: 1, second_inner_col: 1 });
	};
	expect(await executeShelfCommand(session, command, fetcher)).toBe('saved');
	expect(await executeShelfCommand(session, command, fetcher)).toBe('saved'); expect(payloads[0]).toEqual(payloads[1]);
	await expect(executeShelfCommand(session, command, async () => Response.json({}))).rejects.toThrow('acknowledgement');
	expect(() => parseShelfCommand({ ...command, second: bin })).toThrow();
});
test('shelf failures distinguish definite physical conflicts from unknown transport and client errors', () => {
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'BIN_STILL_HAS_PRODUCTS' }))).toBe('notEmpty');
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'STALE_BIN_POSITION' }))).toBe('stale');
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'STALE_SHELF_LAYOUT' }))).toBe('stale');
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'LAYOUT_HAS_PRODUCTS' }))).toBe('notEmpty');
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'INVALID_SHELF_LAYOUT' }))).toBe('invalid');
	expect(shelfFailure(new ApiError(409, { code: '23505', message: 'duplicate key violates cabinets_position_key' }))).toBe('occupied');
	expect(shelfFailure(new ApiError(500, { message: 'BIN_STILL_HAS_PRODUCTS' }))).toBeNull();
	expect(shelfFailure(new TypeError('Network'))).toBeNull();
	expect(shelfFailure(new ApiError(400, { code: 'P0001', message: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' }))).toBeNull();
});
