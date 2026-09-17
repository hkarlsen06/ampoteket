import { requestApiJson } from './api';
import type { CatalogConfig, CatalogProduct, CatalogRequestOptions } from './catalog';

export type ShelfCabinet = {
	id: string; code: string; outer_row: number; outer_col: number;
	inner_rows: number; inner_cols: number; label: string | null;
};
export type ShelfBin = {
	id: string; code: string; cabinet_id: string; inner_row: number; inner_col: number;
	row_span: number; col_span: number; label: string | null;
};
export type ShelfTopology = { cabinets: ShelfCabinet[]; bins: (ShelfBin & { has_products: boolean })[] };

export class ShelfResponseError extends Error {
	constructor() { super('Invalid shelf topology'); this.name = 'ShelfResponseError'; }
}
function invalid(): never { throw new ShelfResponseError(); }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value; }
function identity(value: unknown): string {
	const result = text(value);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) invalid();
	return result;
}
function code(value: unknown): string {
	const result = text(value), length = [...result.replace(/^ +| +$/g, '')].length;
	if (length < 1 || length > 64) invalid();
	return result;
}
function coordinate(value: unknown): number {
	// requestApiJson preserves raw numeric tokens as strings. Only these bounded
	// structural int4 values become JS numbers, never prices or quantities.
	if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalid();
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result > 2147483647) invalid();
	return result;
}
function label(value: unknown): string | null { return value === null ? null : text(value); }

/** A complete topology is a single JSON value, unaffected by the API row cap. */
export function parseShelfTopology(value: unknown): ShelfTopology {
	const raw = object(value);
	if (!Array.isArray(raw.cabinets) || !Array.isArray(raw.bins)) invalid();
	const cabinets = raw.cabinets.map((value): ShelfCabinet => {
		const row = object(value);
		return { id: identity(row.id), code: code(row.code), outer_row: coordinate(row.outer_row),
			outer_col: coordinate(row.outer_col), inner_rows: coordinate(row.inner_rows),
			inner_cols: coordinate(row.inner_cols), label: label(row.label) };
	});
	const cabinetIds = new Map<string, ShelfCabinet>(), cabinetCodes = new Set<string>(), positions = new Set<string>();
	for (const cabinet of cabinets) {
		const position = `${cabinet.outer_row},${cabinet.outer_col}`;
		if (cabinetIds.has(cabinet.id) || cabinetCodes.has(cabinet.code) || positions.has(position)) invalid();
		cabinetIds.set(cabinet.id, cabinet); cabinetCodes.add(cabinet.code); positions.add(position);
	}
	const bins = raw.bins.map((value): ShelfTopology['bins'][number] => {
		const row = object(value);
		if (typeof row.has_products !== 'boolean') invalid();
		return { id: identity(row.id), code: code(row.code), cabinet_id: identity(row.cabinet_id),
			inner_row: coordinate(row.inner_row), inner_col: coordinate(row.inner_col),
			row_span: coordinate(row.row_span), col_span: coordinate(row.col_span),
			label: label(row.label), has_products: row.has_products };
	});
	const binIds = new Set<string>(), binCodes = new Set<string>(), byCabinet = new Map<string, ShelfBin[]>();
	for (const bin of bins) {
		const cabinet = cabinetIds.get(bin.cabinet_id);
		if (!cabinet || binIds.has(bin.id) || binCodes.has(bin.code)
			|| bin.inner_row + bin.row_span - 1 > cabinet.inner_rows
			|| bin.inner_col + bin.col_span - 1 > cabinet.inner_cols) invalid();
		binIds.add(bin.id); binCodes.add(bin.code);
		const neighbors = byCabinet.get(bin.cabinet_id) ?? [];
		if (neighbors.some((other) => bin.inner_row < other.inner_row + other.row_span
			&& other.inner_row < bin.inner_row + bin.row_span
			&& bin.inner_col < other.inner_col + other.col_span
			&& other.inner_col < bin.inner_col + bin.col_span)) invalid();
		neighbors.push(bin); byCabinet.set(bin.cabinet_id, neighbors);
	}
	return { cabinets, bins };
}

export async function readShelfTopology(config: CatalogConfig, options: CatalogRequestOptions = {}): Promise<ShelfTopology> {
	const url = new URL(config.url);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
		|| url.search || url.hash || !config.publishableKey.trim() || config.publishableKey.startsWith('sb_secret_')) {
		throw new TypeError('Invalid public shelf configuration');
	}
	url.pathname = '/rest/v1/rpc/amp_shelf_map';
	return parseShelfTopology(await requestApiJson(url, {
		method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: '{}', credentials: 'omit', cache: 'no-store', signal: options.signal
	}, options.fetcher));
}

/** Match stable bin identity even after it moves to another cabinet. */
export function locateProduct(topology: ShelfTopology, product: CatalogProduct): { cabinet: ShelfCabinet; bin: ShelfTopology['bins'][number]; moved: boolean } | null {
	const bin = topology.bins.find((bin) => bin.code === product.bin_code);
	if (!bin) return null;
	const cabinet = topology.cabinets.find((cabinet) => cabinet.id === bin.cabinet_id)!;
	const moved = cabinet.code !== product.cabinet_code || cabinet.outer_row !== product.outer_row
		|| cabinet.outer_col !== product.outer_col || cabinet.inner_rows !== product.inner_rows
		|| cabinet.inner_cols !== product.inner_cols || bin.inner_row !== product.inner_row
		|| bin.inner_col !== product.inner_col || bin.row_span !== product.row_span || bin.col_span !== product.col_span;
	return { cabinet, bin, moved };
}

/** Bottom-left stored anchor → top-left drawing rectangle; no UI coordinate state. */
export function diagramRect(rows: number, row: number, col: number, rowSpan = 1, colSpan = 1) {
	return { x: col - 1, y: rows - row - rowSpan + 1, width: colSpan, height: rowSpan };
}

/**
 * The drawer wall is Raaco 150-system cabinets (1248-01 and 1224-02 datasheet, mm):
 * every frame is 306 wide × 552 high whatever drawers it holds, so the drawing takes
 * its proportions from the frame and each cabinet's own grid. Walls and gaps are
 * solved from the drawers: 4 × 67 and 3 × 91 mm across leave 11.5 mm side walls and
 * 5 mm between columns; 12 × 41 and 8 × 64 mm down leave 5 mm between rows and
 * 2.5 mm at top and bottom. Stacked cabinets touch, frame to frame.
 */
export const raaco = { width: 306, height: 552, wall: 11.5, end: 2.5, gap: 5 } as const;

/** A drawer front as fractions of its cabinet front; the grid itself is a uniform logical address. */
export function drawerFront(rows: number, cols: number, row: number, col: number, rowSpan = 1, colSpan = 1) {
	const padX = raaco.wall - raaco.gap / 2, padY = raaco.end - raaco.gap / 2;
	const cellWidth = (raaco.width - 2 * padX) / cols, cellHeight = (raaco.height - 2 * padY) / rows;
	const box = diagramRect(rows, row, col, rowSpan, colSpan);
	return { x: (padX + box.x * cellWidth + raaco.gap / 2) / raaco.width, y: (padY + box.y * cellHeight + raaco.gap / 2) / raaco.height,
		width: (box.width * cellWidth - raaco.gap) / raaco.width, height: (box.height * cellHeight - raaco.gap) / raaco.height };
}

export type CabinetInner = { rows: number; cols: number; drawers: { row: number; col: number; rowSpan: number; colSpan: number }[] };
/** A wall cabinet's drawer layout, so its face shows the real drawers. Unplaced drawers are skipped. */
export function cabinetInner(cabinet: { id: string; inner_rows: number; inner_cols: number },
	bins: { cabinet_id: string | null; inner_row: number | null; inner_col: number | null; row_span: number; col_span: number }[]): CabinetInner {
	return { rows: cabinet.inner_rows, cols: cabinet.inner_cols, drawers: bins.flatMap((bin) => bin.cabinet_id === cabinet.id && bin.inner_row && bin.inner_col
		? [{ row: bin.inner_row, col: bin.inner_col, rowSpan: bin.row_span, colSpan: bin.col_span }] : []) };
}

/** Exact even for the largest legal int4 grid, without allocating every free cell. */
export function freeCellCount(cabinet: ShelfCabinet, bins: ShelfBin[]): string {
	return (BigInt(cabinet.inner_rows) * BigInt(cabinet.inner_cols)
		- bins.filter((bin) => bin.cabinet_id === cabinet.id)
			.reduce((sum, bin) => sum + BigInt(bin.row_span) * BigInt(bin.col_span), 0n)).toString();
}
