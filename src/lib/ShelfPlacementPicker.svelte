<script lang="ts">
	// Single-choice location picking on the real shelf graphic (design-system §5):
	// a wall of cabinets, and in bin mode the shared zoom into a cabinet's drawers.
	// Selection state, spatial keyboard navigation and accessible names come from
	// ShelfDiagram; callers render their own readout and clear control. `vacant`
	// adds the wall's empty positions, one row and column beyond the cabinets
	// too, as `vacant:<row>:<col>` choices.
	import { getI18n } from '#lib/i18n/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { gridCell, gridRange } from '#lib/format.js';
	import ShelfDiagram from '#lib/ShelfDiagram.svelte';
	import ShelfZoom from '#lib/ShelfZoom.svelte';
	import { cabinetInner, type ShelfTopology } from '#lib/shelf-map.js';

	let { topology, pick = 'bin', selected, current, vacant = false, onselect, disabled = false }: {
		topology: ShelfTopology; pick?: 'bin' | 'cabinet'; selected: string | null; current?: string; vacant?: boolean;
		onselect: (id: string, event: MouseEvent | KeyboardEvent) => void; disabled?: boolean;
	} = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.adminShelf);
	const cabinets = $derived(topology.cabinets);
	const wallRows = $derived(cabinets.reduce((maximum, cabinet) => Math.max(maximum, cabinet.outer_row), vacant ? 0 : 1) + (vacant ? 1 : 0));
	const wallCols = $derived(cabinets.reduce((maximum, cabinet) => Math.max(maximum, cabinet.outer_col), vacant ? 0 : 1) + (vacant ? 1 : 0));
	const vacancies = $derived.by(() => {
		if (!vacant) return [];
		const cells = [];
		for (let row = 1; row <= wallRows; row++) for (let col = 1; col <= wallCols; col++)
			if (!cabinets.some((cabinet) => cabinet.outer_row === row && cabinet.outer_col === col)) cells.push({ id: `vacant:${row}:${col}`, row, col, label: gridCell(row, col), empty: true });
		return cells;
	});
	// `undefined` follows the chosen drawer's cabinet until the admin zooms
	// themselves; a topology refresh never strands a vanished cabinet.
	let openedId = $state<string | null | undefined>();
	const selectedCabinet = $derived(pick === 'cabinet' ? selected
		: topology.bins.find((bin) => bin.id === selected)?.cabinet_id ?? null);
	const openId = $derived(pick === 'cabinet' ? null : openedId === undefined ? selectedCabinet
		: cabinets.some((cabinet) => cabinet.id === openedId) ? openedId : null);
	const openCabinet = $derived(cabinets.find((cabinet) => cabinet.id === openId));
	const bins = $derived(topology.bins.filter((bin) => bin.cabinet_id === openId));
</script>

{#snippet wallDiagram(onpick: (id: string, event: MouseEvent | KeyboardEvent) => void)}
	<ShelfDiagram responsive rows={wallRows} cols={wallCols} {disabled}
		selected={pick === 'cabinet' ? selected : null}
		current={current ?? selectedCabinet ?? undefined}
		label={m.wall} emptyLabel={m.emptyDrawer} onselect={onpick}
		items={[...cabinets.map((cabinet) => ({ id: cabinet.id, row: cabinet.outer_row, col: cabinet.outer_col,
			label: gridCell(cabinet.outer_row, cabinet.outer_col), inner: cabinetInner(cabinet, topology.bins) })), ...vacancies]} />
{/snippet}

{#if !cabinets.length && !vacant}<Empty.Root><Empty.Description>{m.noCabinets}</Empty.Description></Empty.Root>
{:else if pick === 'cabinet'}
	<div class="placement-picker max-w-80 min-w-0">{@render wallDiagram(onselect)}</div>
{:else}
	<ShelfZoom class="placement-picker max-w-80" {disabled} open={openCabinet ? openId : null} onchange={(id) => { openedId = id; }}
		title={openCabinet ? m.cabinetMap(gridCell(openCabinet.outer_row, openCabinet.outer_col)) : m.wall}>
		{#snippet wall(zoomTo)}{@render wallDiagram(zoomTo)}{/snippet}
		{#snippet cabinet()}
			{#if openCabinet && bins.length}
				<ShelfDiagram cabinet responsive rows={openCabinet.inner_rows} cols={openCabinet.inner_cols} {disabled}
					{selected} current={selected ?? undefined} label={m.cabinetMap(gridCell(openCabinet.outer_row, openCabinet.outer_col))} emptyLabel={m.emptyDrawer}
					{onselect}
					items={bins.map((bin) => ({ id: bin.id, row: bin.inner_row, col: bin.inner_col,
						rowSpan: bin.row_span, colSpan: bin.col_span, empty: !bin.has_products,
						label: gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span) }))} />
			{:else}<Empty.Root><Empty.Description>{m.noBins}</Empty.Description></Empty.Root>{/if}
		{/snippet}
	</ShelfZoom>
{/if}
