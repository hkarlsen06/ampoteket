import { describe, expect, test } from 'bun:test';
import { LayoutError, resizeDrawer, resizeLayout, splitLayout } from './shelf-layout';

let serial = 0;
const identity = () => `drawer-${++serial}`;
const size = { rows: 4, cols: 12 };
const empty = new Set<string>();
const generate = () => resizeLayout([], 'cabinet', null, size, empty, identity);

describe('drawers derived from shelf layout', () => {
	test('4×12 starts with 48 distinct unit drawers and bottom-left coordinates', () => {
		const bins = generate();
		expect(bins).toHaveLength(48);
		expect(new Set(bins.map((bin) => bin.id)).size).toBe(48);
		expect(bins[0]).toMatchObject({ cabinet_id: 'cabinet', inner_row: 1, inner_col: 1, row_span: 1, col_span: 1 });
		expect(bins[47]).toMatchObject({ inner_row: 4, inner_col: 12 });
		expect(() => resizeLayout([], 'cabinet', null, { rows: 65, cols: 65 }, empty, identity)).toThrow(LayoutError);
	});
	test('an occupied source widens without losing identity or consuming an occupied neighbour', () => {
		const original = generate(), anchor = original[0], neighbour = original[1];
		const occupied = new Set([anchor.id]);
		const widened = resizeDrawer(original, size, anchor.id, 2, occupied, identity);
		expect(widened).toHaveLength(47);
		expect(widened.find((bin) => bin.id === anchor.id)).toMatchObject({ code: anchor.code, inner_row: 1, inner_col: 1, col_span: 2 });
		expect(widened.some((bin) => bin.id === neighbour.id)).toBe(false);
		expect(() => resizeDrawer(original, size, anchor.id, 2, new Set([anchor.id, neighbour.id]), identity)).toThrow('notEmpty');
		expect(() => resizeDrawer(widened, size, anchor.id, 1, occupied, identity)).toThrow('notEmpty');
		expect(() => splitLayout(widened, size, anchor.id, occupied, identity)).toThrow('notEmpty');
		expect(original[0]).toEqual(anchor);
	});
	test('partial consumption of a larger neighbour is rejected; whole consumption preserves source', () => {
		const original = generate(), source = original[0];
		const neighbours = resizeDrawer(original, size, original[1].id, 2, empty, identity);
		expect(() => resizeDrawer(neighbours, size, source.id, 2, empty, identity)).toThrow('fit');
		const combined = resizeDrawer(neighbours, size, source.id, 3, new Set([source.id]), identity);
		expect(combined).toHaveLength(46);
		expect(combined.find((bin) => bin.id === source.id)?.col_span).toBe(3);
		expect(() => resizeDrawer(combined, size, source.id, 13, empty, identity)).toThrow('invalid');
	});
	test('shrinking and splitting empty drawers derives unit drawers and retains the source identity', () => {
		const original = generate(), source = original[0];
		const widened = resizeDrawer(original, size, source.id, 3, empty, identity);
		const narrowed = resizeDrawer(widened, size, source.id, 2, empty, identity);
		expect(narrowed).toHaveLength(47);
		expect(narrowed.find((bin) => bin.inner_row === 1 && bin.inner_col === 3)?.col_span).toBe(1);
		const split = splitLayout(narrowed, size, source.id, empty, identity);
		expect(split).toHaveLength(48);
		expect(split.find((bin) => bin.id === source.id)).toEqual(source);
		expect(split.find((bin) => bin.inner_row === 1 && bin.inner_col === 2)?.id).not.toBe(original[1].id);
	});
	test('applying grid dimensions fills uncovered cells; assigned edge drawers prevent shrink', () => {
		const original = generate(), missing = original[0], edge = original[47];
		const expanded = resizeLayout(original.slice(1), 'cabinet', size, { rows: 5, cols: 12 }, empty, identity);
		expect(expanded).toHaveLength(60);
		expect(expanded.find((bin) => bin.inner_row === 1 && bin.inner_col === 1)?.id).not.toBe(missing.id);
		expect(expanded[0]).toEqual(original[1]);
		expect(() => resizeLayout(original, 'cabinet', size, { rows: 3, cols: 12 }, new Set([edge.id]), identity)).toThrow('notEmpty');
		const shrunk = resizeLayout(original, 'cabinet', size, { rows: 3, cols: 12 }, empty, identity);
		expect(shrunk).toHaveLength(36);
		expect(shrunk[0]).toEqual(original[0]);
	});
});
