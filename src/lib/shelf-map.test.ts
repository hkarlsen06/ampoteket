import { describe, expect, test } from 'bun:test';
import { parseApiJson } from './api';
import type { CatalogProduct } from './catalog';
import { binProducts, cabinetInner, diagramRect, drawerFront, drawerNeighbours, freeCellCount, locateProduct, parseShelfTopology, readShelfTopology, ShelfResponseError } from './shelf-map';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const cabinet = (n = 1, row = 1) => ({ id: id(n), code: `CAB-${n}`, outer_row: row, outer_col: 1, inner_rows: 4, inner_cols: 10, label: null });
const bin = (n = 11) => ({ id: id(n), code: `BIN-${n}`, cabinet_id: id(1), inner_row: 1, inner_col: 1, row_span: 1, col_span: 1, label: null, has_products: false });
const decode = (value: unknown) => parseShelfTopology(parseApiJson(JSON.stringify(value)));
const config = { url: 'https://shelf.example.invalid', publishableKey: 'sb_publishable_test' };

describe('complete shelf topology', () => {
	test('retains empty cabinets and bins independently of published products', () => {
		const map = decode({ cabinets: [cabinet(), cabinet(2, 3)], bins: [bin(), { ...bin(12), inner_row: 3, inner_col: 3, row_span: 2, col_span: 2, has_products: true }] });
		expect(map.cabinets).toHaveLength(2);
		expect(map.bins).toHaveLength(2);
		expect(map.bins.map((entry) => entry.has_products)).toEqual([false, true]);
		expect(map.cabinets[1].outer_row).toBe(3);
		expect(freeCellCount(map.cabinets[0], map.bins)).toBe('35');
		expect(freeCellCount(map.cabinets[1], map.bins)).toBe('40');
		expect(decode({ cabinets: [], bins: [] })).toEqual({ cabinets: [], bins: [] });
	});
	test('rejects missing fields, wrong structural types, unknown parents and impossible spans', () => {
		for (const patch of [{ id: 'bad' }, { code: '' }, { inner_rows: 0 }, { outer_col: null },
			{ outer_row: '2147483648' }, { inner_cols: 1.5 }, { label: undefined }]) {
			expect(() => decode({ cabinets: [{ ...cabinet(), ...patch }], bins: [] })).toThrow(ShelfResponseError);
		}
		for (const patch of [{ cabinet_id: id(3) }, { inner_row: 5 }, { inner_col: 10, col_span: 2 },
			{ has_products: undefined }, { has_products: 'false' }, { has_products: 0 }, { row_span: 0 }, { inner_row: 4, row_span: 2 }, { code: ' ' }, { label: true }]) {
			expect(() => decode({ cabinets: [cabinet()], bins: [{ ...bin(), ...patch }] })).toThrow(ShelfResponseError);
		}
		for (const value of [null, [], {}, { cabinets: [], bins: null }, { cabinets: [], bins: [bin()] }]) {
			expect(() => decode(value)).toThrow(ShelfResponseError);
		}
		// Valid numeric tokens must pass through the lossless boundary first.
		expect(() => parseShelfTopology({ cabinets: [cabinet()], bins: [] })).toThrow(ShelfResponseError);
	});
	test('rejects duplicate identities/codes/positions and overlapping rectangles', () => {
		for (const other of [cabinet(), { ...cabinet(2, 2), code: 'CAB-1' }, cabinet(2, 1)]) {
			expect(() => decode({ cabinets: [cabinet(), other], bins: [] })).toThrow(ShelfResponseError);
		}
		for (const other of [bin(), { ...bin(12), code: 'BIN-11', inner_col: 5 }, bin(12),
			{ ...bin(12), inner_row: 2, inner_col: 2 }]) {
			expect(() => decode({ cabinets: [cabinet()], bins: [{ ...bin(), row_span: 2, col_span: 2 }, other] })).toThrow(ShelfResponseError);
		}
		const adjacent = decode({ cabinets: [cabinet()], bins: [{ ...bin(), row_span: 2, col_span: 2 }, { ...bin(12), inner_col: 3 }] });
		expect(adjacent.bins).toHaveLength(2);
	});
	test('handles sparse/extreme legal grids without allocating cells or rounding counts', () => {
		const map = decode({ cabinets: [{ ...cabinet(), outer_row: 2147483647, inner_rows: 2147483647, inner_cols: 2147483647 }], bins: [bin()] });
		expect(freeCellCount(map.cabinets[0], map.bins)).toBe('4611686014132420608');
	});
	test('places A1 at bottom-left, row 4 at top and spans upwards/rightwards', () => {
		expect(diagramRect(4, 1, 1)).toEqual({ x: 0, y: 3, width: 1, height: 1 });
		expect(diagramRect(4, 4, 1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(diagramRect(4, 3, 3, 2, 2)).toEqual({ x: 2, y: 0, width: 2, height: 2 });
	});
	test('matches stable drawer identity after a move, never invents a missing drawer', () => {
		const product = { cabinet_code: 'CAB-1', bin_code: 'BIN-11', outer_row: 1, outer_col: 1,
			inner_rows: 4, inner_cols: 10, inner_row: 1, inner_col: 1, row_span: 1, col_span: 1 } as CatalogProduct;
		const original = decode({ cabinets: [cabinet(), cabinet(2, 2)], bins: [bin()] });
		expect(locateProduct(original, product)?.moved).toBe(false);
		const moved = decode({ cabinets: [cabinet(), cabinet(2, 2)], bins: [{ ...bin(), cabinet_id: id(2), inner_row: 3, row_span: 2 }] });
		const location = locateProduct(moved, product);
		expect(location?.moved).toBe(true);
		expect(location?.cabinet.code).toBe('CAB-2');
		expect(location?.bin.inner_row).toBe(3);
		expect(locateProduct({ ...moved, bins: [] }, product)).toBeNull();
	});
	test('requests only the public topology RPC, supports abort and rejects errors rather than emptying storage', async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | null | undefined;
		const map = await readShelfTopology(config, { signal: controller.signal, fetcher: async (input, init) => {
			expect(String(input)).toBe('https://shelf.example.invalid/rest/v1/rpc/amp_shelf_map');
			expect(init?.body).toBe('{}'); expect(init?.method).toBe('POST');
			expect(init?.credentials).toBe('omit'); expect(init?.cache).toBe('no-store');
			requestSignal = init?.signal; expect(requestSignal?.aborted).toBe(false); expect(init?.redirect).toBe('manual');
			expect(new Headers(init?.headers).get('apikey')).toBe(config.publishableKey);
			expect(new Headers(init?.headers).has('Authorization')).toBe(false);
			return new Response(JSON.stringify({ cabinets: [cabinet()], bins: [bin()] }));
		} });
		expect(map.bins[0].code).toBe('BIN-11');
		controller.abort(); expect(requestSignal?.aborted).toBe(true);
		await expect(readShelfTopology(config, { fetcher: async () => new Response('{}', { status: 503 }) })).rejects.toThrow();
		await expect(readShelfTopology(config, { fetcher: async () => new Response('{}') })).rejects.toThrow(ShelfResponseError);
		await expect(readShelfTopology({ ...config, publishableKey: 'sb_secret_wrong' })).rejects.toThrow(TypeError);
	});
});

describe('Raaco drawer fronts', () => {
	test('reproduce the datasheet drawers of both cabinet types', () => {
		for (const [rows, cols, width, height] of [[12, 4, 67, 41], [8, 3, 91, 64]]) {
			const front = drawerFront(rows, cols, 1, 1);
			expect(front.width * 306).toBeCloseTo(width, 6);
			expect(front.height * 552).toBeCloseTo(height, 6);
			expect((front.y + front.height) * 552).toBeCloseTo(552 - 2.5, 6);
		}
		const merged = drawerFront(10, 4, 1, 1, 1, 4);
		expect(merged.x + merged.width).toBeCloseTo(1 - 11.5 / 306, 6);
	});
	test('skip other cabinets and unplaced drawers', () => {
		const bins = [{ cabinet_id: id(1), inner_row: 2, inner_col: 1, row_span: 1, col_span: 2 },
			{ cabinet_id: id(2), inner_row: 1, inner_col: 1, row_span: 1, col_span: 1 }, { cabinet_id: id(1), inner_row: null, inner_col: null, row_span: 1, col_span: 1 }];
		expect(cabinetInner(cabinet(), bins)).toEqual({ rows: 4, cols: 10, drawers: [{ row: 2, col: 1, rowSpan: 1, colSpan: 2 }] });
	});
});

describe('drawer neighbours', () => {
	// One 4 × 4 cabinet, row 1 at the bottom (C1, D1 and D4 are empty cells):
	//   4  A3–A4  B4–C4
	//   3  A3–A4  B3     C2–D3
	//   2  A2     B2     C2–D3
	//   1  A1     B1
	const drawer = (name: string, row: number, col: number, rowSpan = 1, colSpan = 1, cabinetId = id(1)) =>
		({ id: name, cabinet_id: cabinetId, inner_row: row, inner_col: col, row_span: rowSpan, col_span: colSpan });
	const bins = [drawer('A1', 1, 1), drawer('B1', 1, 2), drawer('A2', 2, 1), drawer('B2', 2, 2), drawer('C2-D3', 2, 3, 2, 2),
		drawer('B3', 3, 2), drawer('A3-A4', 3, 1, 2), drawer('B4-C4', 4, 2, 1, 2), drawer('other', 2, 3, 1, 1, id(2))];
	const names = (binId: string) => {
		const value = drawerNeighbours(bins, binId);
		return value && Object.fromEntries(Object.entries(value).map(([side, list]) => [side, list.map((bin) => bin.id)]));
	};

	test('finds the drawer above, below, left and right, counting rows upward', () => {
		expect(names('B2')).toEqual({ above: ['B3'], left: ['A2'], right: ['C2-D3'], below: ['B1'] });
	});
	test('lists every drawer along a spanning edge, top to bottom or left to right', () => {
		expect(names('C2-D3')).toEqual({ above: ['B4-C4'], left: ['B3', 'B2'], right: [], below: [] });
		expect(names('B4-C4')).toEqual({ above: [], left: ['A3-A4'], right: [], below: ['B3', 'C2-D3'] });
	});
	test('omits cabinet edges, empty cells and other cabinets', () => {
		expect(names('A1')).toEqual({ above: ['A2'], left: [], right: ['B1'], below: [] });
		expect(names('other')).toEqual({ above: [], left: [], right: [], below: [] });
		expect(names('missing')).toBeNull();
	});
	test('lists one drawer’s products by code, published or not', () => {
		const products = [{ code: 'RES-B', bin_id: 'B2', is_active: false }, { code: 'RES-A', bin_id: 'B2', is_active: true },
			{ code: 'CAP-A', bin_id: 'B3', is_active: true }, { code: 'MIS-A', bin_id: null, is_active: true }];
		expect(binProducts(products, 'B2').map((product) => product.code)).toEqual(['RES-A', 'RES-B']);
		expect(binProducts(products, null).map((product) => product.code)).toEqual(['MIS-A']);
		expect(binProducts(products, 'A1')).toEqual([]);
	});
});
