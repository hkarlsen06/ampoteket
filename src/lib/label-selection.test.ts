import { describe, expect, test } from 'bun:test';
import { labelCabinets, labelDrawers, labelSelectionState, toggleLabelSelection } from './label-selection';
import type { ShelfTopology } from './shelf-map';

describe('shelf selections for product labels', () => {
	test('follows visual order, including drawers anchored below their top edge', () => {
		const topology = {
			cabinets: [
				{ id: 'bottom', outer_row: 1, outer_col: 1 },
				{ id: 'top-right', outer_row: 2, outer_col: 2 },
				{ id: 'top-left', outer_row: 2, outer_col: 1 }
			],
			bins: [
				{ id: 'bottom', cabinet_id: 'top-left', inner_row: 1, inner_col: 1, row_span: 1 },
				{ id: 'right', cabinet_id: 'top-left', inner_row: 4, inner_col: 2, row_span: 1 },
				{ id: 'tall', cabinet_id: 'top-left', inner_row: 3, inner_col: 1, row_span: 2 },
				{ id: 'other', cabinet_id: 'bottom', inner_row: 1, inner_col: 1, row_span: 1 }
			]
		} as ShelfTopology;
		expect(labelCabinets(topology).map((cabinet) => cabinet.id)).toEqual(['top-left', 'top-right', 'bottom']);
		expect(labelDrawers(topology, 'top-left').map((drawer) => drawer.id)).toEqual(['tall', 'right', 'bottom']);
		expect(topology.cabinets[0].id).toBe('bottom');
		expect(topology.bins[0].id).toBe('bottom');
	});
	test('whole cabinet toggles include empty drawers, with partial selection becoming full', () => {
		const groups = [{ id: 'cabinet', drawerIds: ['occupied', 'empty'] }, { id: 'no-drawers', drawerIds: [] }];
		const original = ['elsewhere', 'occupied'];
		expect(labelSelectionState(groups[0].drawerIds, new Set(original))).toBe('some');
		const selected = toggleLabelSelection(original, groups, 'cabinet');
		expect(selected).toEqual(['elsewhere', 'occupied', 'empty']);
		expect(labelSelectionState(groups[0].drawerIds, new Set(selected))).toBe('all');
		expect(toggleLabelSelection(selected, groups, 'cabinet')).toEqual(['elsewhere']);
		expect(toggleLabelSelection(original, groups, 'no-drawers')).toEqual(original);
		expect(labelSelectionState([], new Set(original))).toBe('none');
		expect(original).toEqual(['elsewhere', 'occupied']);
	});
	test('shift ranges are inclusive and reversible across cabinet rows', () => {
		const groups = [
			{ id: 'A2', drawerIds: ['a2', 'a2-other'] }, { id: 'B2', drawerIds: ['b2'] },
			{ id: 'A1', drawerIds: ['a1'] }, { id: 'B1', drawerIds: ['b1'] }
		];
		const forward = toggleLabelSelection(['a2'], groups, 'A1', 'A2', true);
		expect(new Set(forward)).toEqual(new Set(['a2', 'a2-other', 'b2', 'a1']));
		expect(new Set(toggleLabelSelection(['a1'], groups, 'A2', 'A1', true))).toEqual(new Set(forward));
		expect(toggleLabelSelection([...forward, 'b1'], groups, 'A1', 'A2', true)).toEqual(['b1']);
	});
	test('drawer ranges preserve selections elsewhere and tolerate a removed anchor', () => {
		const groups = ['left', 'middle', 'right'].map((id) => ({ id, drawerIds: [id] }));
		expect(toggleLabelSelection(['other', 'left'], groups, 'right', 'left', true)).toEqual(['other', 'left', 'middle', 'right']);
		expect(toggleLabelSelection(['other', 'left'], groups, 'right', 'removed', true)).toEqual(['other', 'left', 'right']);
		expect(toggleLabelSelection(['other', 'left'], groups, 'right', 'left')).toEqual(['other', 'left', 'right']);
		expect(toggleLabelSelection(['other'], groups, 'missing')).toEqual(['other']);
	});
});
