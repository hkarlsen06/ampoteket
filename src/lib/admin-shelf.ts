import { ApiError } from './api';
import { allStaffRows, staffEquals, staffRequest, type StaffSession } from './admin-api';
import { identifier, object, text, type Fetcher } from './api';
import { parseShelfTopology, type ShelfBin, type ShelfCabinet, type ShelfTopology } from './shelf-map';

export type AdminCabinet = Omit<ShelfCabinet, 'outer_row' | 'outer_col'> & {
	outer_row: number | null; outer_col: number | null; is_archived: boolean;
};
export type AdminBin = Omit<ShelfBin, 'cabinet_id' | 'inner_row' | 'inner_col'> & {
	cabinet_id: string | null; inner_row: number | null; inner_col: number | null; is_archived: boolean;
};
export type AssignedProduct = { id: string; code: string; name_nb: string; name_en: string; bin_id: string | null; is_active: boolean };
export type ArchivedBinLocation = { binId: string; cabinetId: string; cabinetCode: string; cabinetLabel: string | null;
	cabinetOuterRow: number | null; cabinetOuterCol: number | null; innerRow: number; innerCol: number; rowSpan: number; colSpan: number };
export type AdminShelf = { cabinets: AdminCabinet[]; bins: AdminBin[]; products: AssignedProduct[]; archivedLocations: Map<string, ArchivedBinLocation>; live: ShelfTopology };
const cabinetSelect = 'id,code,outer_row,outer_col,inner_rows,inner_cols,label,is_archived';
const binSelect = 'id,code,cabinet_id,inner_row,inner_col,row_span,col_span,label,is_archived';
const archivedLocationSelect = 'bin_id,cabinet_id,cabinet_code,cabinet_label,cabinet_outer_row,cabinet_outer_col,inner_row,inner_col,row_span,col_span';

/** Only bounded structural coordinates become numbers. Stock and money never do. */
export function shelfInteger(value: unknown): number {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Invalid shelf coordinate');
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result > 2147483647) throw new Error('Invalid shelf coordinate');
	return result;
}
export function shelfColumn(value: string): number {
	if (!/^[A-Za-z]+$/.test(value)) throw new Error('Invalid shelf column');
	let result = 0;
	for (const character of value.toUpperCase()) {
		result = result * 26 + character.charCodeAt(0) - 64;
		if (result > 2147483647) throw new Error('Invalid shelf column');
	}
	return result;
}
function label(value: unknown): string | null {
	if (value !== null && typeof value !== 'string') throw new Error('Invalid storage label');
	return value;
}
function archived(value: unknown): boolean {
	if (typeof value !== 'boolean') throw new Error('Invalid archive state');
	return value;
}
export function parseAdminCabinet(value: unknown): AdminCabinet {
	const row = object(value), is_archived = archived(row.is_archived);
	if (is_archived && (row.outer_row !== null || row.outer_col !== null)) throw new Error('Archived cabinet has placement');
	return { id: identifier(row.id), code: text(row.code, 64), label: label(row.label), is_archived,
		outer_row: is_archived ? null : shelfInteger(row.outer_row), outer_col: is_archived ? null : shelfInteger(row.outer_col),
		inner_rows: shelfInteger(row.inner_rows), inner_cols: shelfInteger(row.inner_cols) };
}
export function parseAdminBin(value: unknown): AdminBin {
	const row = object(value), is_archived = archived(row.is_archived);
	if (is_archived && (row.cabinet_id !== null || row.inner_row !== null || row.inner_col !== null)) throw new Error('Archived drawer has placement');
	return { id: identifier(row.id), code: text(row.code, 64), label: label(row.label), is_archived,
		cabinet_id: is_archived ? null : identifier(row.cabinet_id), inner_row: is_archived ? null : shelfInteger(row.inner_row),
		inner_col: is_archived ? null : shelfInteger(row.inner_col), row_span: shelfInteger(row.row_span), col_span: shelfInteger(row.col_span) };
}
function apiCoordinates(value: AdminCabinet | AdminBin): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'number' ? String(item) : item]));
}
function parseAssignment(value: unknown): AssignedProduct {
	const row = object(value), code = text(row.code, 40);
	if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code) || typeof row.is_active !== 'boolean' || (row.is_active && row.bin_id === null)) throw new Error('Invalid assigned product');
	return { id: identifier(row.id), code, name_nb: text(row.name_nb, 200), name_en: text(row.name_en, 200),
		bin_id: row.bin_id === null ? null : identifier(row.bin_id), is_active: row.is_active };
}
function parseArchivedLocation(value: unknown): ArchivedBinLocation {
	const row = object(value);
	if ((row.cabinet_outer_row === null) !== (row.cabinet_outer_col === null)) throw new Error('Invalid archived cabinet location');
	return { binId: identifier(row.bin_id), cabinetId: identifier(row.cabinet_id), cabinetCode: text(row.cabinet_code, 64),
		cabinetLabel: label(row.cabinet_label), cabinetOuterRow: row.cabinet_outer_row === null ? null : shelfInteger(row.cabinet_outer_row),
		cabinetOuterCol: row.cabinet_outer_col === null ? null : shelfInteger(row.cabinet_outer_col),
		innerRow: shelfInteger(row.inner_row), innerCol: shelfInteger(row.inner_col),
		rowSpan: shelfInteger(row.row_span), colSpan: shelfInteger(row.col_span) };
}
export async function readAdminShelf(session: StaffSession, fetcher: Fetcher = fetch): Promise<AdminShelf> {
	const [cabinetRows, binRows, productRows, archivedRows] = await Promise.all([
		allStaffRows(session, 'amp_cabinets', cabinetSelect, 'id', {}, fetcher),
		allStaffRows(session, 'amp_bins', binSelect, 'id', {}, fetcher),
		// Inactive assignments prevent retirement too. Never use the public catalog here.
		allStaffRows(session, 'amp_products', 'id,code,name_nb,name_en,bin_id,is_active', 'id', {}, fetcher),
		allStaffRows(session, 'amp_archived_bin_locations', archivedLocationSelect, 'bin_id', {}, fetcher)
	]);
	const cabinets = cabinetRows.map(parseAdminCabinet), bins = binRows.map(parseAdminBin), products = productRows.map(parseAssignment);
	const archivedLocations = new Map(archivedRows.map((row) => { const location = parseArchivedLocation(row); return [location.binId, location] as const; }));
	if (new Set(cabinets.map((row) => row.code)).size !== cabinets.length || new Set(bins.map((row) => row.code)).size !== bins.length) throw new Error('Duplicate storage code');
	if (archivedLocations.size !== archivedRows.length || [...archivedLocations.keys()].some((id) => !bins.some((bin) => bin.id === id && bin.is_archived))) throw new Error('Invalid archived drawer locations');
	const assigned = new Set(products.flatMap((row) => row.bin_id ? [row.bin_id] : []));
	const live = parseShelfTopology({ cabinets: cabinets.filter((row) => !row.is_archived).map(apiCoordinates),
		bins: bins.filter((row) => !row.is_archived).map((row) => ({ ...apiCoordinates(row), has_products: assigned.has(row.id) })) });
	const liveBins = new Set(live.bins.map((row) => row.id));
	if (products.some((row) => row.bin_id && !liveBins.has(row.bin_id))) throw new Error('Inconsistent storage assignments');
	return { cabinets, bins, products, archivedLocations, live };
}

type ActorCommand = { userId: string; requestId: string };
export type ShelfCommand = ActorCommand & (
	{ kind: 'layout'; before: AdminCabinet | null; beforeBins: AdminBin[]; after: AdminCabinet; bins: AdminBin[] }
	| { kind: 'archive-cabinet'; before: AdminCabinet; beforeBins: AdminBin[] }
	| { kind: 'cabinet'; before: AdminCabinet; after: AdminCabinet }
	| { kind: 'bin'; before: AdminBin; after: AdminBin }
	| { kind: 'swap-cabinets'; first: AdminCabinet; second: AdminCabinet }
	| { kind: 'swap-bins'; first: AdminBin; second: AdminBin }
);
const commandKey = 'ampoteket:admin-shelf:v1';
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function storageRow(value: unknown, kind: 'cabinet' | 'bin') {
	const row = object(value);
	for (const key of kind === 'cabinet' ? ['outer_row', 'outer_col', 'inner_rows', 'inner_cols'] : ['inner_row', 'inner_col', 'row_span', 'col_span']) {
		if (row[key] !== null && (typeof row[key] !== 'number' || !Number.isInteger(row[key]))) throw new Error('Invalid saved coordinate');
	}
	const converted = Object.fromEntries(Object.entries(row).map(([key, item]) => [key, typeof item === 'number' ? String(item) : item]));
	return kind === 'cabinet' ? parseAdminCabinet(converted) : parseAdminBin(converted);
}
export function parseShelfCommand(value: unknown): ShelfCommand {
	const row = object(value), actor = { userId: identifier(row.userId), requestId: identifier(row.requestId) };
	if (row.kind === 'archive-cabinet') {
		const before = storageRow(row.before, 'cabinet') as AdminCabinet;
		if (before.is_archived || !Array.isArray(row.beforeBins) || row.beforeBins.length > 4096) throw new Error('Invalid cabinet archive');
		const beforeBins = row.beforeBins.map((value) => storageRow(value, 'bin') as AdminBin);
		if (new Set(beforeBins.map((bin) => bin.id)).size !== beforeBins.length
			|| beforeBins.some((bin) => bin.is_archived || bin.cabinet_id !== before.id)) throw new Error('Invalid cabinet drawers');
		return { ...actor, kind: 'archive-cabinet', before, beforeBins };
	}
	if (row.kind === 'layout') {
		const before = row.before === null ? null : storageRow(row.before, 'cabinet') as AdminCabinet;
		const after = storageRow(row.after, 'cabinet') as AdminCabinet;
		if (after.is_archived || after.inner_rows * after.inner_cols > 4096
			|| (before && (before.id !== after.id || before.code !== after.code))) throw new Error('Invalid layout cabinet');
		function bins(value: unknown, cabinet: AdminCabinet | null): AdminBin[] {
			if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid layout drawers');
			const parsed = value.map((bin) => storageRow(bin, 'bin') as AdminBin);
			if (!cabinet || cabinet.is_archived) {
				if (parsed.length) throw new Error('Layout drawers require a live cabinet');
			} else {
				if (parsed.some((bin) => bin.is_archived || bin.cabinet_id !== cabinet.id)) throw new Error('Invalid layout drawer placement');
				// This validates draft geometry only; product assignments are rechecked by the RPC.
				parseShelfTopology({ cabinets: [apiCoordinates(cabinet)], bins: parsed.map((bin) => ({ ...apiCoordinates(bin), has_products: false })) });
			}
			return parsed;
		}
		const beforeBins = bins(row.beforeBins, before), afterBins = bins(row.bins, after);
		const original = new Map(beforeBins.map((bin) => [bin.id, bin]));
		if (afterBins.some((bin) => original.has(bin.id) && original.get(bin.id)!.code !== bin.code)) throw new Error('Drawer identity changed');
		return { ...actor, kind: 'layout', before, beforeBins, after, bins: afterBins };
	}
	if (row.kind === 'cabinet' || row.kind === 'bin') {
		const before = storageRow(row.before, row.kind), after = storageRow(row.after, row.kind);
		if (before.id !== after.id || before.code !== after.code) throw new Error('Storage identity changed');
		if ('outer_row' in before && 'outer_row' in after
			? before.inner_rows !== after.inner_rows || before.inner_cols !== after.inner_cols
			: 'row_span' in before && 'row_span' in after && (before.row_span !== after.row_span || before.col_span !== after.col_span)) {
			throw new Error('Drawer sizes belong to the shelf layout');
		}
		return { ...actor, kind: row.kind, before, after } as ShelfCommand;
	}
	if (row.kind === 'swap-cabinets' || row.kind === 'swap-bins') {
		const kind = row.kind === 'swap-cabinets' ? 'cabinet' : 'bin';
		const first = storageRow(row.first, kind), second = storageRow(row.second, kind);
		if (first.id === second.id || first.is_archived || second.is_archived) throw new Error('Two distinct live locations required');
		return { ...actor, kind: row.kind, first, second } as ShelfCommand;
	}
	throw new Error('Invalid shelf command');
}
export function readShelfCommand(storage: Pick<Storage, 'getItem'>): ShelfCommand | null {
	const raw = storage.getItem(commandKey);
	return raw ? parseShelfCommand(JSON.parse(raw)) : null;
}
export function saveShelfCommand(storage: CommandStorage, command: ShelfCommand): ShelfCommand {
	const parsed = parseShelfCommand(command), existing = readShelfCommand(storage);
	if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('Unresolved shelf command');
	const raw = JSON.stringify(parsed); storage.setItem(commandKey, raw);
	if (storage.getItem(commandKey) !== raw) throw new Error('Shelf command persistence unavailable');
	return parsed;
}
export function clearShelfCommand(storage: CommandStorage, command: ShelfCommand): void {
	const current = readShelfCommand(storage);
	if (current && JSON.stringify(current) !== JSON.stringify(parseShelfCommand(command))) throw new Error('Shelf command changed');
	storage.removeItem(commandKey);
	if (storage.getItem(commandKey) !== null) throw new Error('Shelf command remains unresolved');
}
function same(a: AdminCabinet | AdminBin, b: AdminCabinet | AdminBin): boolean {
	return Object.entries(a).every(([key, value]) => b[key as keyof typeof b] === value);
}
function guards(row: AdminCabinet | AdminBin): Record<string, string> {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, staffEquals(value)]));
}
/** Read back an uncertain direct write; never replace the original preconditions. */
export async function executeShelfCommand(session: StaffSession, input: ShelfCommand, fetcher: Fetcher = fetch): Promise<'saved' | 'stale'> {
	const command = parseShelfCommand(input);
	if (session.userId !== command.userId) throw new Error('Shelf command identity changed');
	if (command.kind === 'archive-cabinet') {
		const result = object(await staffRequest(session, 'rpc/amp_archive_empty_cabinet', {}, {
			p_request_id: command.requestId, p_before: command.before, p_before_bins: command.beforeBins
		}, 'POST', fetcher));
		if (result.cabinet_id !== command.before.id || result.archived_bins !== String(command.beforeBins.length)) throw new Error('Invalid archive acknowledgement');
		return 'saved';
	}
	if (command.kind === 'layout') {
		const result = object(await staffRequest(session, 'rpc/amp_save_shelf_layout', {}, {
			p_request_id: command.requestId, p_before: command.before, p_cabinet: command.after,
			p_before_bins: command.beforeBins, p_bins: command.bins
		}, 'POST', fetcher));
		if (result.cabinet_id !== command.after.id || result.saved !== true) throw new Error('Invalid layout acknowledgement');
		return 'saved';
	}
	if (command.kind === 'cabinet' || command.kind === 'bin') {
		const path = command.kind === 'cabinet' ? 'amp_cabinets' : 'amp_bins';
		const select = command.kind === 'cabinet' ? cabinetSelect : binSelect;
		const parse = command.kind === 'cabinet' ? parseAdminCabinet : parseAdminBin;
		const read = await staffRequest(session, path, { select, id: `eq.${command.after.id}`, limit: '2' }, undefined, 'POST', fetcher);
		if (!Array.isArray(read) || read.length > 1) throw new Error('Invalid storage readback');
		const current = read.length ? parse(read[0]) : null;
		if (current && same(current, command.after)) return 'saved';
		if (!current || !same(current, command.before)) return 'stale';
		const { id: _id, code: _code, ...changes } = command.after;
		const result = await staffRequest(session, path, { select, ...guards(command.before) }, changes, 'PATCH', fetcher);
		if (!Array.isArray(result) || result.length > 1) throw new Error('Invalid storage write response');
		if (!result.length) return 'stale';
		if (!same(parse(result[0]), command.after)) throw new Error('Storage acknowledgement mismatch');
		return 'saved';
	}
	let path: string, payload: Record<string, unknown>, expected: Record<string, string | number | null>;
	if (command.kind === 'swap-cabinets') {
		const a = command.first, b = command.second;
		path = 'rpc/amp_swap_cabinets';
		payload = { p_request_id: command.requestId, p_first_cabinet_id: a.id, p_second_cabinet_id: b.id,
			p_expected_first_outer_row: a.outer_row, p_expected_first_outer_col: a.outer_col,
			p_expected_second_outer_row: b.outer_row, p_expected_second_outer_col: b.outer_col };
		expected = { first_cabinet_id: a.id, first_outer_row: b.outer_row, first_outer_col: b.outer_col,
			second_cabinet_id: b.id, second_outer_row: a.outer_row, second_outer_col: a.outer_col };
	} else {
		const a = command.first, b = command.second;
		path = 'rpc/amp_swap_bins';
		payload = { p_request_id: command.requestId, p_first_bin_id: a.id, p_second_bin_id: b.id,
			p_expected_first_cabinet_id: a.cabinet_id, p_expected_first_inner_row: a.inner_row, p_expected_first_inner_col: a.inner_col,
			p_expected_first_row_span: a.row_span, p_expected_first_col_span: a.col_span,
			p_expected_second_cabinet_id: b.cabinet_id, p_expected_second_inner_row: b.inner_row, p_expected_second_inner_col: b.inner_col,
			p_expected_second_row_span: b.row_span, p_expected_second_col_span: b.col_span };
		expected = { first_bin_id: a.id, first_cabinet_id: b.cabinet_id, first_inner_row: b.inner_row, first_inner_col: b.inner_col,
			second_bin_id: b.id, second_cabinet_id: a.cabinet_id, second_inner_row: a.inner_row, second_inner_col: a.inner_col };
	}
	const result = object(await staffRequest(session, path, {}, payload, 'POST', fetcher));
	if (!Object.entries(expected).every(([key, value]) => result[key] === (typeof value === 'number' ? String(value) : value))) throw new Error('Invalid swap acknowledgement');
	return 'saved';
}

/** Only definite database rejections release a command; transport failures stay retryable. */
export function shelfFailure(error: unknown): 'stale' | 'occupied' | 'fit' | 'notEmpty' | 'invalid' | null {
	if (!(error instanceof ApiError) || ![400, 409, 422].includes(error.status)) return null;
	const body = error.body && typeof error.body === 'object' ? error.body as Record<string, unknown> : {};
	const message = typeof body.message === 'string' ? body.message : '';
	if (/^(STALE_SHELF_LAYOUT|STALE_(BIN|CABINET)_POSITION|BIN_ARCHIVED|CABINET_ARCHIVED|BIN_NOT_FOUND|CABINET_NOT_FOUND)(:|$)/.test(message)) return 'stale';
	if (message.startsWith('BIN_POSITION_OCCUPIED') || (body.code === '23505' && message.includes('cabinets_position_key'))) return 'occupied';
	if (/^(BIN_DOES_NOT_FIT_CABINET_GRID|CABINET_SHRINK_WOULD_ORPHAN_BINS)(:|$)/.test(message)) return 'fit';
	if (/^(LAYOUT_HAS_PRODUCTS|BIN_STILL_HAS_PRODUCTS|CABINET_STILL_HAS_BINS)(:|$)/.test(message)) return 'notEmpty';
	if (message.startsWith('INVALID_SHELF_LAYOUT')) return 'invalid';
	if (typeof body.code === 'string' && ['23502', '23505', '23514', '22P02', '22003'].includes(body.code)) return 'invalid';
	return null;
}
