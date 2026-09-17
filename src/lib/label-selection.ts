import type { ShelfTopology } from './shelf-map';

export type LabelSelectionGroup = { id: string; drawerIds: readonly string[] };
export type LabelSelectionState = 'none' | 'some' | 'all';

/** Reading order follows the drawing: top to bottom, then left to right. */
export function labelCabinets(topology: ShelfTopology) {
	return [...topology.cabinets].sort((a, b) => b.outer_row - a.outer_row
		|| a.outer_col - b.outer_col || a.id.localeCompare(b.id));
}

export function labelDrawers(topology: ShelfTopology, cabinetId: string) {
	return topology.bins.filter((bin) => bin.cabinet_id === cabinetId)
		.sort((a, b) => (b.inner_row + b.row_span) - (a.inner_row + a.row_span)
			|| a.inner_col - b.inner_col || a.id.localeCompare(b.id));
}

export function labelSelectionState(drawerIds: readonly string[], selected: ReadonlySet<string>): LabelSelectionState {
	if (!drawerIds.length) return 'none';
	const count = drawerIds.filter((id) => selected.has(id)).length;
	return count === drawerIds.length ? 'all' : count ? 'some' : 'none';
}

/** Toggle the target, or apply its new state to an inclusive anchored range.
 * Groups may be cabinets containing many drawers or individual drawers. Other
 * cabinets' selections survive drawer changes; empty cabinets select nothing.
 */
export function toggleLabelSelection(selected: readonly string[], groups: readonly LabelSelectionGroup[],
	targetId: string, anchorId: string | null = null, range = false): string[] {
	const targetIndex = groups.findIndex((group) => group.id === targetId);
	const next = new Set(selected);
	if (targetIndex === -1 || !groups[targetIndex].drawerIds.length) return [...next];
	const anchorIndex = range ? groups.findIndex((group) => group.id === anchorId) : -1;
	const start = anchorIndex === -1 ? targetIndex : Math.min(anchorIndex, targetIndex);
	const end = anchorIndex === -1 ? targetIndex : Math.max(anchorIndex, targetIndex);
	const selecting = labelSelectionState(groups[targetIndex].drawerIds, next) !== 'all';
	for (const group of groups.slice(start, end + 1)) {
		for (const id of group.drawerIds) {
			if (selecting) next.add(id); else next.delete(id);
		}
	}
	return [...next];
}
