import type { AdminBin } from './admin-shelf';

export const maxLayoutCells = 4096;
export type LayoutSize = { rows: number; cols: number };
type Identity = () => string;
export class LayoutError extends Error {
	constructor(public readonly reason: 'invalid' | 'notEmpty' | 'fit') { super(reason); }
}
export function validateLayoutSize(size: LayoutSize): void {
	if (![size.rows, size.cols].every((n) => Number.isSafeInteger(n) && n > 0) || size.rows * size.cols > maxLayoutCells) throw new LayoutError('invalid');
}
function cells(bin: AdminBin): string[] {
	if (bin.is_archived || !bin.inner_row || !bin.inner_col) throw new LayoutError('invalid');
	return Array.from({ length: bin.row_span * bin.col_span }, (_, i) => `${bin.inner_row! + Math.floor(i / bin.col_span)},${bin.inner_col! + i % bin.col_span}`);
}
function newBin(cabinetId: string, row: number, col: number, identity: Identity): AdminBin {
	const id = identity();
	return { id, code: `B-${id}`, cabinet_id: cabinetId, inner_row: row, inner_col: col, row_span: 1, col_span: 1, label: null, is_archived: false };
}
function completeLayout(bins: AdminBin[], cabinetId: string, size: LayoutSize, identity: Identity): AdminBin[] {
	const result = bins.map((bin) => ({ ...bin })), occupied = new Set(bins.flatMap(cells));
	for (let row = 1; row <= size.rows; row++) for (let col = 1; col <= size.cols; col++) {
		if (!occupied.has(`${row},${col}`)) result.push(newBin(cabinetId, row, col, identity));
	}
	return result;
}
/** Applying a layout derives every uncovered unit drawer; moving a drawer does not. */
export function resizeLayout(bins: AdminBin[], cabinetId: string, previous: LayoutSize | null, next: LayoutSize,
	assigned: ReadonlySet<string>, identity: Identity = () => crypto.randomUUID()): AdminBin[] {
	validateLayoutSize(next);
	if (previous) validateLayoutSize(previous);
	const retained = bins.filter((bin) => {
		const fits = bin.inner_row! + bin.row_span - 1 <= next.rows && bin.inner_col! + bin.col_span - 1 <= next.cols;
		if (!fits && assigned.has(bin.id)) throw new LayoutError('notEmpty');
		return fits;
	});
	return completeLayout(retained, cabinetId, next, identity);
}
/** Widen at the same anchor, keeping its products. Consume only whole, unassigned neighbours. */
export function resizeDrawer(bins: AdminBin[], size: LayoutSize, id: string, width: number,
	assigned: ReadonlySet<string>, identity: Identity = () => crypto.randomUUID()): AdminBin[] {
	validateLayoutSize(size);
	const source = bins.find((bin) => bin.id === id);
	if (!source || !Number.isSafeInteger(width) || width < 1 || source.inner_col! + width - 1 > size.cols) throw new LayoutError('invalid');
	if (width === source.col_span) return bins.map((bin) => ({ ...bin }));
	if (width < source.col_span && assigned.has(id)) throw new LayoutError('notEmpty');
	const after = { ...source, col_span: width };
	const covered = new Set(cells(after));
	const neighbours = bins.filter((bin) => bin.id !== id && cells(bin).some((cell) => covered.has(cell)));
	if (neighbours.some((bin) => assigned.has(bin.id))) throw new LayoutError('notEmpty');
	if (neighbours.some((bin) => cells(bin).some((cell) => !covered.has(cell)))) throw new LayoutError('fit');
	const removed = new Set(neighbours.map((bin) => bin.id));
	const result = bins.filter((bin) => !removed.has(bin.id)).map((bin) => bin.id === id ? after : bin);
	return completeLayout(result, source.cabinet_id!, size, identity);
}
export function splitLayout(bins: AdminBin[], size: LayoutSize, id: string, assigned: ReadonlySet<string>, identity: Identity = () => crypto.randomUUID()): AdminBin[] {
	validateLayoutSize(size);
	const source = bins.find((bin) => bin.id === id);
	if (!source) throw new LayoutError('invalid');
	if (assigned.has(id)) throw new LayoutError('notEmpty');
	const result = bins.map((bin) => bin.id === id ? { ...bin, row_span: 1, col_span: 1 } : bin);
	return completeLayout(result, source.cabinet_id!, size, identity);
}
