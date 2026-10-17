import { api, errorCode, type StaffSession } from './convex';
import { identifier, object, text } from './api';
import { parseShelfTopology, type ShelfBin, type ShelfCabinet, type ShelfTopology } from './shelf-map';

export type AdminCabinet = Omit<ShelfCabinet, 'outer_row' | 'outer_col'> & {
	outer_row: number | null; outer_col: number | null; is_archived: boolean;
};
export type AdminBin = Omit<ShelfBin, 'cabinet_id' | 'inner_row' | 'inner_col'> & {
	cabinet_id: string | null; inner_row: number | null; inner_col: number | null; is_archived: boolean;
};
export type AssignedProduct = { id: string; code: string; name_nb: string; name_en: string; bin_id: string | null; is_active: boolean };
export type AdminShelf = { cabinets: AdminCabinet[]; bins: AdminBin[]; products: AssignedProduct[]; live: ShelfTopology };

const maxCoordinate = 2147483647;
/** A typed wall row: only bounded structural coordinates become numbers. Stock and money never do. */
export function shelfInteger(value: unknown): number {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Invalid shelf coordinate');
	return coordinate(Number(value));
}
function coordinate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maxCoordinate) throw new Error('Invalid shelf coordinate');
	return value;
}
export function shelfColumn(value: string): number {
	if (!/^[A-Za-z]+$/.test(value)) throw new Error('Invalid shelf column');
	let result = 0;
	for (const character of value.toUpperCase()) {
		result = result * 26 + character.charCodeAt(0) - 64;
		if (result > maxCoordinate) throw new Error('Invalid shelf column');
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
		outer_row: is_archived ? null : coordinate(row.outer_row), outer_col: is_archived ? null : coordinate(row.outer_col),
		inner_rows: coordinate(row.inner_rows), inner_cols: coordinate(row.inner_cols) };
}
export function parseAdminBin(value: unknown): AdminBin {
	const row = object(value), is_archived = archived(row.is_archived);
	if (is_archived && (row.cabinet_id !== null || row.inner_row !== null || row.inner_col !== null)) throw new Error('Archived drawer has placement');
	return { id: identifier(row.id), code: text(row.code, 64), label: label(row.label), is_archived,
		cabinet_id: is_archived ? null : identifier(row.cabinet_id), inner_row: is_archived ? null : coordinate(row.inner_row),
		inner_col: is_archived ? null : coordinate(row.inner_col), row_span: coordinate(row.row_span), col_span: coordinate(row.col_span) };
}
function parseAssignment(value: unknown): AssignedProduct {
	const row = object(value), code = text(row.code, 40);
	if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code) || typeof row.is_active !== 'boolean') throw new Error('Invalid assigned product');
	return { id: identifier(row.id), code, name_nb: text(row.name_nb, 200), name_en: text(row.name_en, 200),
		bin_id: row.bin_id === null ? null : identifier(row.bin_id), is_active: row.is_active };
}
/** Every cabinet and drawer, archived too, and every product's drawer, inactive ones included: they block retirement too. */
export async function readAdminShelf(session: StaffSession): Promise<AdminShelf> {
	const raw = await session.client.query(api.shelf.admin, {});
	const cabinets = raw.cabinets.map(parseAdminCabinet), bins = raw.bins.map(parseAdminBin), products = raw.products.map(parseAssignment);
	if (new Set(cabinets.map((row) => row.code)).size !== cabinets.length || new Set(bins.map((row) => row.code)).size !== bins.length) throw new Error('Duplicate storage code');
	const assigned = new Set(products.flatMap((row) => row.bin_id ? [row.bin_id] : []));
	const live = parseShelfTopology({ cabinets: cabinets.filter((row) => !row.is_archived),
		bins: bins.filter((row) => !row.is_archived).map((row) => ({ ...row, has_products: assigned.has(row.id) })) });
	const liveBins = new Set(live.bins.map((row) => row.id));
	if (products.some((row) => row.bin_id && !liveBins.has(row.bin_id))) throw new Error('Inconsistent storage assignments');
	return { cabinets, bins, products, live };
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
	return kind === 'cabinet' ? parseAdminCabinet(value) : parseAdminBin(value);
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
				// This validates draft geometry only; product assignments are rechecked by the backend.
				parseShelfTopology({ cabinets: [cabinet], bins: parsed.map((bin) => ({ ...bin, has_products: false })) });
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
/**
 * Run a saved command. Layouts, archives and swaps carry their request ID, so a
 * retry after a lost reply returns the first result. A direct move is a
 * compare-and-set against the row as shown: the backend answers 'saved' when the
 * row already matches the target and 'stale' when it no longer matches the original.
 */
export async function executeShelfCommand(session: StaffSession, input: ShelfCommand): Promise<'saved' | 'stale'> {
	const command = parseShelfCommand(input);
	if (session.userId !== command.userId) throw new Error('Shelf command identity changed');
	const { client } = session;
	if (command.kind === 'archive-cabinet') {
		const result = await client.mutation(api.shelf.archiveCabinet, { requestId: command.requestId, before: command.before, beforeBins: command.beforeBins });
		if (result.cabinet_id !== command.before.id || result.archived_bins !== command.beforeBins.length) throw new Error('Invalid archive acknowledgement');
		return 'saved';
	}
	if (command.kind === 'layout') {
		const result = await client.mutation(api.shelf.saveLayout, { requestId: command.requestId, before: command.before,
			cabinet: command.after, beforeBins: command.beforeBins, bins: command.bins });
		if (result.cabinet_id !== command.after.id || result.saved !== true) throw new Error('Invalid layout acknowledgement');
		return 'saved';
	}
	if (command.kind === 'cabinet') return await client.mutation(api.shelf.updateCabinet, { before: command.before, after: command.after });
	if (command.kind === 'bin') return await client.mutation(api.shelf.updateBin, { before: command.before, after: command.after });
	let result: Record<string, unknown>, expected: Record<string, string | number | null>;
	if (command.kind === 'swap-cabinets') {
		const a = command.first, b = command.second;
		result = await client.mutation(api.shelf.swapCabinets, { requestId: command.requestId, first: a, second: b });
		expected = { first_cabinet_id: a.id, first_outer_row: b.outer_row, first_outer_col: b.outer_col,
			second_cabinet_id: b.id, second_outer_row: a.outer_row, second_outer_col: a.outer_col };
	} else {
		const a = command.first, b = command.second;
		result = await client.mutation(api.shelf.swapBins, { requestId: command.requestId, first: a, second: b });
		expected = { first_bin_id: a.id, first_cabinet_id: b.cabinet_id, first_inner_row: b.inner_row, first_inner_col: b.inner_col,
			second_bin_id: b.id, second_cabinet_id: a.cabinet_id, second_inner_row: a.inner_row, second_inner_col: a.inner_col };
	}
	if (!Object.entries(expected).every(([key, value]) => result[key] === value)) throw new Error('Invalid swap acknowledgement');
	return 'saved';
}

const failures: Record<string, 'stale' | 'occupied' | 'fit' | 'notEmpty' | 'invalid'> = {
	STALE_SHELF_LAYOUT: 'stale', STALE_BIN_POSITION: 'stale', STALE_CABINET_POSITION: 'stale', BIN_ARCHIVED: 'stale',
	CABINET_ARCHIVED: 'stale', BIN_NOT_FOUND: 'stale', CABINET_NOT_FOUND: 'stale',
	BIN_POSITION_OCCUPIED: 'occupied', CABINET_POSITION_OCCUPIED: 'occupied',
	BIN_DOES_NOT_FIT_CABINET_GRID: 'fit',
	LAYOUT_HAS_PRODUCTS: 'notEmpty', BIN_STILL_HAS_PRODUCTS: 'notEmpty', CABINET_STILL_HAS_BINS: 'notEmpty',
	INVALID_SHELF_LAYOUT: 'invalid', STORAGE_IDENTITY_IS_IMMUTABLE: 'invalid',
	TWO_DISTINCT_BINS_AND_POSITIONS_REQUIRED: 'invalid', TWO_DISTINCT_CABINETS_AND_POSITIONS_REQUIRED: 'invalid'
};
/** Only definite rejections release a command; an unknown outcome (network, server bug) stays retryable. */
export function shelfFailure(error: unknown): 'stale' | 'occupied' | 'fit' | 'notEmpty' | 'invalid' | null {
	const code = errorCode(error);
	return code !== null && Object.hasOwn(failures, code) ? failures[code] : null;
}
