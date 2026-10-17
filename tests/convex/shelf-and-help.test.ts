// Shelf layout guards and the volunteer directory (datamodell.md §9–10).
import { beforeEach, describe, expect, test } from 'bun:test';
import { api } from '../../convex/_generated/api';
import { enabled, freshDeployment, guest, product, rejected, staff, uuid } from './harness';

const cabinetA1 = 'a0000001-0000-4000-8000-000000000001';

describe.skipIf(!enabled)('shelf', () => {
	beforeEach(freshDeployment);

	test('the seeded wall is public; archived storage and occupancy are reflected', async () => {
		const map = await guest().query(api.catalog.shelfMap, {});
		expect(map.cabinets).toHaveLength(12);
		expect(map.bins).toHaveLength(492);
		const { client } = await staff();
		const p = await product(client);
		expect((await guest().query(api.catalog.shelfMap, {})).bins.find((b) => b.id === p.bin_id)?.has_products).toBe(true);
	});

	test('a layout cannot remove, move or shrink a drawer holding products', async () => {
		const { client } = await staff();
		await product(client); // in A1's drawer at A1
		const shelf = await client.query(api.shelf.admin, {});
		const before = shelf.cabinets.find((c) => c.id === cabinetA1)!;
		const beforeBins = shelf.bins.filter((b) => b.cabinet_id === cabinetA1);
		const without = beforeBins.filter((b) => b.inner_row !== 1 || b.inner_col !== 1);
		expect(await rejected(client.mutation(api.shelf.saveLayout, { requestId: uuid(), before, cabinet: before, beforeBins, bins: without })))
			.toBe('LAYOUT_HAS_PRODUCTS');
		// Removing an empty drawer is fine and archives it.
		const emptyGone = beforeBins.filter((b) => b.inner_row !== 12 || b.inner_col !== 4);
		await client.mutation(api.shelf.saveLayout, { requestId: uuid(), before, cabinet: before, beforeBins, bins: emptyGone });
		const after = await client.query(api.shelf.admin, {});
		expect(after.bins.filter((b) => b.cabinet_id === cabinetA1)).toHaveLength(47);
		// The editor's old snapshot is now stale.
		expect(await rejected(client.mutation(api.shelf.saveLayout, { requestId: uuid(), before, cabinet: before, beforeBins, bins: emptyGone })))
			.toBe('STALE_SHELF_LAYOUT');
		const archived = after.bins.find((b) => b.is_archived)!;
		expect((await client.query(api.shelf.archivedBinLocations, { binIds: [archived.id] }))[0]).toMatchObject({ cabinet_id: cabinetA1, inner_row: 12, inner_col: 4 });
	});

	test('moves need free space; swaps exchange positions', async () => {
		const { client } = await staff();
		const shelf = await client.query(api.shelf.admin, {});
		const [a, b] = shelf.cabinets.filter((c) => c.outer_row === 1).sort((x, y) => x.outer_col! - y.outer_col!);
		expect(await rejected(client.mutation(api.shelf.updateCabinet, { before: a, after: { ...a, outer_col: b.outer_col } }))).toBe('CABINET_POSITION_OCCUPIED');
		await client.mutation(api.shelf.updateCabinet, { before: a, after: { ...a, outer_row: 3, outer_col: 1 } });
		expect(await client.mutation(api.shelf.updateCabinet, { before: a, after: { ...a, label: 'x' } })).toBe('stale');
		const moved = { ...a, outer_row: 3, outer_col: 1 };
		const result = await client.mutation(api.shelf.swapCabinets, { requestId: uuid(), first: moved, second: b });
		expect(result).toMatchObject({ first_outer_row: b.outer_row, first_outer_col: b.outer_col, second_outer_row: 3, second_outer_col: 1 });
	});
});

describe.skipIf(!enabled)('help directory', () => {
	beforeEach(freshDeployment);

	test('only published, reachable contacts are public; edits are revision-guarded; order is whole-list guarded', async () => {
		const { client } = await staff();
		const fields = { display_name: 'Ada', responsibility: 'Lodding', email: null, phone: null, contact_url: null, discord: null, is_published: true };
		expect(await rejected(client.mutation(api.help.save, { id: uuid(), revision: null, fields }))).toBe('HELP_CONTACT_NOT_REACHABLE');
		const ada = await client.mutation(api.help.save, { id: uuid(), revision: null, fields: { ...fields, discord: 'ada_l' } });
		const bo = await client.mutation(api.help.save, { id: uuid(), revision: null, fields: { ...fields, display_name: 'Bo', discord: 'bo.b', is_published: false } });
		expect((await guest().query(api.catalog.helpDirectory, {})).map((c) => c.display_name)).toEqual(['Ada']);
		await client.mutation(api.help.save, { id: ada.id, revision: ada.edit_revision, fields: { ...fields, discord: 'ada_2' } });
		expect(await rejected(client.mutation(api.help.save, { id: ada.id, revision: ada.edit_revision, fields: { ...fields, discord: 'ada_3' } }))).toBe('STALE_HELP_CONTACT');
		expect(await rejected(client.mutation(api.help.reorder, { ids: [bo.id, ada.id], expectedIds: [bo.id, ada.id] }))).toBe('STALE_HELP_ORDER');
		await client.mutation(api.help.reorder, { ids: [bo.id, ada.id], expectedIds: [ada.id, bo.id] });
		// A retry of a move that already happened succeeds without another write.
		await client.mutation(api.help.reorder, { ids: [bo.id, ada.id], expectedIds: [ada.id, bo.id] });
		expect((await client.query(api.help.list, {})).map((c) => c.id)).toEqual([bo.id, ada.id]);
	});
});
