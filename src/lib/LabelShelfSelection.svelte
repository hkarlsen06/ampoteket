<script lang="ts">
	import { sectionHeading } from '#lib/ui.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { gridCell, gridRange } from '#lib/format.js';
	import ShelfDiagram from '#lib/ShelfDiagram.svelte';
	import ShelfZoom from '#lib/ShelfZoom.svelte';
	import ShelfCabinetFace from '#lib/ShelfCabinetFace.svelte';
	import { cabinetInner, raaco, type ShelfTopology } from '#lib/shelf-map.js';
	import { labelCabinets, labelDrawers, labelSelectionState, toggleLabelSelection } from '#lib/label-selection.js';
	import { revealShelfFocus } from '#lib/shelf-focus.js';
	import { untrack } from 'svelte';

	// With onpick it is a single-drawer picker: no checkboxes or bulk controls
	// (the caller offers clearing), and choosing a drawer calls onpick instead of
	// changing the selection. Its cabinet stays height-bounded so it never scrolls.
	let { topology, selected, onselection, onpick, onselectall, onclear, heading, disabled = false }: {
		topology: ShelfTopology; selected: string[]; onselection?: (ids: string[]) => void; onpick?: (id: string) => void; disabled?: boolean;
		onselectall?: () => void; onclear?: () => void; heading?: string | null;
	} = $props();
	const i18n = getI18n(), uid = $props.id();
	const m = $derived(i18n.m.adminLabels);
	const cabinets = $derived(labelCabinets(topology));
	const groups = $derived(cabinets.map((cabinet) => ({ id: cabinet.id, drawerIds: labelDrawers(topology, cabinet.id).map((bin) => bin.id) })));
	const available = $derived(new Set(topology.bins.map((bin) => bin.id)));
	const chosen = $derived(new Set(selected.filter((id) => available.has(id))));
	const wallRows = $derived(cabinets.reduce((maximum, cabinet) => Math.max(maximum, cabinet.outer_row), 1));
	const wallCols = $derived(cabinets.reduce((maximum, cabinet) => Math.max(maximum, cabinet.outer_col), 1));
	// A picker opens on the cabinet of the drawer it shows.
	let openedId = $state<string | null>(untrack(() => onpick && selected.length === 1 ? topology.bins.find((bin) => bin.id === selected[0])?.cabinet_id ?? null : null));
	let cabinetAnchor = $state<string | null>(null);
	// A cabinet that leaves the topology returns the stage to the wall.
	const openCabinet = $derived(cabinets.find((cabinet) => cabinet.id === openedId));
	let drawerAnchors = $state<Record<string, string>>({});

	function toggleCabinet(id: string, event: MouseEvent | KeyboardEvent) {
		if (disabled) return;
		onselection?.(toggleLabelSelection([...chosen], groups, id, cabinetAnchor, event.shiftKey));
		if (!event.shiftKey || !groups.some((group) => group.id === cabinetAnchor)) cabinetAnchor = id;
	}
	function toggleDrawer(cabinetId: string, id: string, event: MouseEvent | KeyboardEvent) {
		if (disabled) return;
		if (onpick) { onpick(id); return; }
		const drawers = labelDrawers(topology, cabinetId).map((bin) => ({ id: bin.id, drawerIds: [bin.id] }));
		onselection?.(toggleLabelSelection([...chosen], drawers, id, drawerAnchors[cabinetId] ?? null, event.shiftKey));
		if (!event.shiftKey || !drawers.some((bin) => bin.id === drawerAnchors[cabinetId])) drawerAnchors[cabinetId] = id;
	}
	function cabinetKey(event: KeyboardEvent, id: string) {
		// Keep selection in the parent, including Shift ranges, instead of letting
		// the checkbox maintain a separate checked state for keyboard activation.
		if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggleCabinet(id, event); }
	}
	function selectAll(all: boolean) {
		if (disabled) return;
		cabinetAnchor = null; drawerAnchors = {};
		onselection?.(all ? groups.flatMap((group) => group.drawerIds) : []);
		if (all) onselectall?.(); else onclear?.();
	}
</script>

<!-- heading={null} when a surrounding dialog title already names the selection. -->
<section class="label-shelf-selection min-w-0 wrap-break-word" aria-labelledby={heading === null ? undefined : `${uid}-title`}>
	{#if heading !== null}<h2 id={`${uid}-title`} class={[sectionHeading, "m-0 mb-4"]}>{heading ?? m.selectionHeading}</h2>{/if}
	{#if !onpick}
		<div class="flex flex-wrap items-start gap-2">
			<Button variant="outline" type="button" disabled={disabled || !available.size && !onselectall} onclick={() => selectAll(true)}>{m.selectAll}</Button>
			<Button variant="ghost" type="button" class="font-normal" disabled={disabled || !chosen.size && !onclear} onclick={() => selectAll(false)}>{m.clearSelection}</Button>
		</div>
		<p class="mt-3 mb-0 min-h-6">{m.selectedDrawers(chosen.size)}</p>
	{/if}
	{#if !cabinets.length}
		<Empty.Root><Empty.Description>{m.emptyShelf}</Empty.Description></Empty.Root>
	{:else}
		{#if !onpick}<p class="mt-6 mb-4 hidden text-sm text-muted-foreground [@media(pointer:fine)]:block">{m.keyboardHint}</p>{/if}
		<ShelfZoom class={onpick ? undefined : 'max-w-xl'} headingLevel={2} {disabled} open={openCabinet?.id ?? null} onchange={(id) => { openedId = id; }}
			title={openCabinet ? m.cabinet(gridCell(openCabinet.outer_row, openCabinet.outer_col)) : m.wall}>
			{#snippet wall(zoomTo)}
				<!-- The same steel faces as ShelfDiagram's wall: Raaco cabinets touching frame to frame. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (The named shelf viewport supports native keyboard scrolling.) -->
				<div class="wall-viewport min-w-0 max-h-[min(32rem,70dvh)] overflow-auto overscroll-contain p-1" role="region" aria-label={m.wall} tabindex="0"
					onfocusin={(event) => { if (event.target !== event.currentTarget) revealShelfFocus(event.target as HTMLElement, event.currentTarget); }}>
				<!-- Keep each checkbox inside its cabinet and leave room for the longest coordinate. -->
				<!-- The picker sits in a narrow sheet: large labels would widen the wall past it. -->
				<div class={['wall-diagram relative grid font-mono text-base', !onpick && 'md:text-2xl']} role="group" aria-label={m.wall} data-zoom-frame
					style:grid-template-columns={`repeat(${wallCols}, minmax(0, 1fr))`}
					style:min-width={`max(${wallCols * 3}rem, ${wallCols * (gridCell(wallRows, wallCols).length + 2)}ch)`}>
					{#each cabinets as cabinet (cabinet.id)}
						{@const position = gridCell(cabinet.outer_row, cabinet.outer_col)}
						{@const bins = labelDrawers(topology, cabinet.id)}
						{@const state = labelSelectionState(bins.map((bin) => bin.id), chosen)}
						<div class="relative min-h-16 w-full min-w-0" style:aspect-ratio={raaco.width / raaco.height} style:grid-row={wallRows - cabinet.outer_row + 1} style:grid-column={cabinet.outer_col}>
							<Button variant="outline" type="button" {disabled} aria-label={m.cabinet(position)} data-zoom-face={cabinet.id} onclick={() => zoomTo(cabinet.id)} class={[
								'relative h-full min-h-16 w-full rounded-none border border-steel-seam bg-steel p-0 font-mono text-base font-normal text-foreground hover:border-foreground hover:bg-steel', !onpick && 'md:text-2xl',
								state === 'all' && 'border-3 border-foreground', state === 'some' && 'border-3 border-dashed border-foreground'
							]}><ShelfCabinetFace label={position} inner={cabinetInner(cabinet, topology.bins)} /></Button>
							<!-- Shelf-diagram exception (design-system §4): a 24px target, so it never covers the cabinet button. -->
							{#if !onpick}<Checkbox class="absolute top-1 left-1 after:inset-0" aria-label={m.selectCabinet(position)}
								checked={state === 'all'} indeterminate={state === 'some'} disabled={disabled || !bins.length}
								onclick={(event) => { event.preventDefault(); toggleCabinet(cabinet.id, event); }}
								onkeydown={(event) => cabinetKey(event, cabinet.id)} />{/if}
						</div>
					{/each}
				</div>
				</div>
			{/snippet}
			{#snippet cabinet()}
				{#if openCabinet}
					{@const bins = labelDrawers(topology, openCabinet.id)}
					{#if openCabinet.label}<p class="text-sm text-muted-foreground">{openCabinet.label}</p>{/if}
					{#if !bins.length}
						<Empty.Root><Empty.Description>{m.emptyCabinet}</Empty.Description></Empty.Root>
					{:else}
						<div class={onpick ? undefined : 'max-w-96'}>
							<ShelfDiagram cabinet responsive rows={openCabinet.inner_rows} cols={openCabinet.inner_cols}
								selected={onpick ? selected[0] ?? null : null} selectedIds={onpick ? undefined : [...chosen]}
								{disabled} label={m.cabinet(gridCell(openCabinet.outer_row, openCabinet.outer_col))} emptyLabel={m.emptyDrawer}
								onselect={(id, event) => toggleDrawer(openCabinet.id, id, event)}
								items={bins.map((bin) => ({ id: bin.id, row: bin.inner_row, col: bin.inner_col,
									rowSpan: bin.row_span, colSpan: bin.col_span, empty: !bin.has_products,
									label: gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span) }))} />
						</div>
					{/if}
				{/if}
			{/snippet}
		</ShelfZoom>
	{/if}
</section>
