<script lang="ts">
	import { untrack } from 'svelte';
	import { formActions } from '#lib/ui.js';
	import { toast } from 'svelte-sonner';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import ShelfGrip from '#lib/ShelfGrip.svelte';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { gridRange } from '#lib/format.js';
	import type { AdminBin } from '#lib/admin-shelf.js';
	import { LayoutError, maxLayoutCells, resizeDrawer, resizeLayout, splitLayout, type LayoutSize } from '#lib/shelf-layout.js';
	import ShelfDiagram from '#lib/ShelfDiagram.svelte';

	// eslint-disable-next-line no-useless-assignment -- $bindable() declares a two-way prop, not a value.
	let { cabinetId, bins = $bindable(), size = $bindable(), rowsText = $bindable(), colsText = $bindable(), original,
		assigned, disabled = false, initialSelected = '', moving = false, onempty, onselect, onswap, onswapselect }: {
		cabinetId: string; bins: AdminBin[]; size: LayoutSize; rowsText: string; colsText: string;
		original: AdminBin[]; assigned: ReadonlySet<string>; disabled?: boolean; initialSelected?: string; moving?: boolean; onempty?: (row: number, col: number) => void; onselect?: (id: string) => void; onswap?: (first: string, second: string) => void; onswapselect?: (id: string) => void;
	} = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.adminShelf);
	let selected = $state(untrack(() => initialSelected)), changedRange = $state('');
	let frame = $state<HTMLDivElement | null>(null);
	let drag = $state<{ axis: 'rows' | 'cols'; pointer: number; start: number; step: number; initial: number; value: number } | null>(null);
	const current = $derived(bins.find((bin) => bin.id === selected));
	const removed = $derived(original.filter((bin) => !bins.some((value) => value.id === bin.id)).length);
	const proposedSize = $derived(drag ? { ...size, [drag.axis]: drag.value } : size);
	const preview = $derived.by(() => {
		if (!drag) return { bins, size };
		let nextId = 0;
		try { return { bins: resizeLayout(bins, cabinetId, size, proposedSize, assigned, () => `preview-${++nextId}`), size: proposedSize }; }
		catch { return { bins, size }; }
	});
	const vacant = $derived.by(() => {
		if (!moving) return [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch set inside a derived.
		const occupied = new Set<string>();
		for (const bin of bins) for (let row = bin.inner_row!; row < bin.inner_row! + bin.row_span; row++)
			for (let col = bin.inner_col!; col < bin.inner_col! + bin.col_span; col++) occupied.add(`${row}:${col}`);
		const cells = [];
		for (let row = 1; row <= size.rows; row++) for (let col = 1; col <= size.cols; col++)
			if (!occupied.has(`${row}:${col}`)) cells.push({ id: `vacant:${row}:${col}`, row, col, empty: true, label: m.emptyPosition(gridRange(row, col, 1, 1)) });
		return cells;
	});
	$effect(() => { if (disabled) drag = null; });
	function change(action: () => AdminBin[]) {
		if (disabled || moving) return;
		try {
			bins = action();
			const after = bins.find((bin) => bin.id === selected);
			changedRange = after ? gridRange(after.inner_row!, after.inner_col!, after.row_span, after.col_span) : '';
		} catch (failure) { toast.error(m[failure instanceof LayoutError ? failure.reason : 'invalid'], { id: 'shelf-layout-error' }); changedRange = ''; }
	}
	function resize(axis: 'rows' | 'cols', value: number) {
		if (value === size[axis]) return;
		change(() => {
			const next = { ...size, [axis]: value };
			const result = resizeLayout(bins, cabinetId, size, next, assigned);
			size = next;
			rowsText = String(next.rows); colsText = String(next.cols);
			return result;
		});
	}
	function maximum(axis: 'rows' | 'cols') { return Math.floor(maxLayoutCells / size[axis === 'rows' ? 'cols' : 'rows']); }
	function startResize(event: PointerEvent, axis: 'rows' | 'cols') {
		if (disabled || moving || event.button !== 0 || !event.isPrimary || drag) return;
		const bounds = frame?.querySelector('.cabinet-frame')?.getBoundingClientRect();
		if (!bounds) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.focus({ preventScroll: true }); target.setPointerCapture(event.pointerId);
		drag = { axis, pointer: event.pointerId, start: axis === 'rows' ? -event.clientY : event.clientX,
			step: Math.max(24, (axis === 'rows' ? bounds.height : bounds.width) / size[axis]), initial: size[axis], value: size[axis] };
	}
	function moveResize(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointer) return;
		const position = drag.axis === 'rows' ? -event.clientY : event.clientX;
		drag.value = Math.max(1, Math.min(maximum(drag.axis), drag.initial + Math.round((position - drag.start) / drag.step)));
	}
	function finishResize(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointer) return;
		moveResize(event);
		const { axis, value } = drag; drag = null;
		resize(axis, value);
	}
	function resizeKey(event: KeyboardEvent, axis: 'rows' | 'cols') {
		if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); drag = null; return; }
		const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
		if (!delta) return;
		event.preventDefault();
		if (!drag) resize(axis, Math.max(1, Math.min(maximum(axis), size[axis] + delta)));
	}
	function resizeSelected(id: string, width: number) { change(() => resizeDrawer(bins, size, id, width, assigned)); }
	function select(id: string) {
		if (id.startsWith('vacant:')) { const [, row, col] = id.split(':'); onempty?.(Number(row), Number(col)); return; }
		selected = id; changedRange = ''; onselect?.(id); }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); drag = null; } }} />

{#snippet grips()}
	{#each ['rows', 'cols'] as dimension (dimension)}
		{@const axis = dimension as 'rows' | 'cols'}
		<Button variant="ghost" size="icon-sm" type="button" role="slider" aria-label={axis === 'rows' ? m.resizeRows : m.resizeCols}
			aria-valuemin={1} aria-valuemax={maximum(axis)} aria-valuenow={proposedSize[axis]} aria-orientation={axis === 'rows' ? 'vertical' : 'horizontal'}
			disabled={disabled || moving} class={`cabinet-edge-grip absolute z-30 size-11 touch-none p-0 active:not-aria-[haspopup]:-translate-y-1/2 ${axis === 'rows' ? 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' : 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize'}`}
			onpointerdown={(event) => startResize(event, axis)} onpointermove={moveResize} onpointerup={finishResize}
			onpointercancel={() => drag = null} onlostpointercapture={() => drag = null} onkeydown={(event) => resizeKey(event, axis)}>
			<span class={`flex items-center justify-center rounded-sm border border-muted-foreground bg-card p-1 text-card-foreground ${axis === 'rows' ? 'rotate-90' : ''}`}><ShelfGrip /></span>
		</Button>
	{/each}
{/snippet}

<div class="layout-editor min-w-0" data-resizing={drag ? 'true' : undefined}>
	<Collapsible.Root>
		<DisclosureTrigger>{m.grid(proposedSize.rows, proposedSize.cols)}</DisclosureTrigger>
		<Collapsible.Content>
			<p class="text-sm text-muted-foreground">{m.layoutHint}</p>
	<div class="my-3 flex flex-wrap gap-3">
		{#each ['rows', 'cols'] as dimension (dimension)}
			{@const axis = dimension as 'rows' | 'cols'}
			<div role="group" aria-label={axis === 'rows' ? m.innerRows : m.innerCols} class="flex items-center gap-1">
				<Button variant="outline" type="button" size="icon" aria-label={axis === 'rows' ? m.removeRow : m.removeColumn}
					disabled={disabled || moving || !!drag || size[axis] === 1} onclick={() => resize(axis, size[axis] - 1)}>−</Button>
				<Button variant="outline" type="button" disabled={disabled || moving || !!drag || size[axis] >= maximum(axis)} onclick={() => resize(axis, size[axis] + 1)}>
					<span aria-hidden="true">+</span> {axis === 'rows' ? m.addRow : m.addColumn}
				</Button>
			</div>
		{/each}
	</div>
		</Collapsible.Content>
	</Collapsible.Root>
	<div bind:this={frame}>
		<ShelfDiagram cabinet editorGeometry responsive rows={preview.size.rows} cols={preview.size.cols}
			items={[...preview.bins.map((bin) => ({ id: bin.id, row: bin.inner_row!, col: bin.inner_col!, rowSpan: bin.row_span, colSpan: bin.col_span,
				label: gridRange(bin.inner_row!, bin.inner_col!, bin.row_span, bin.col_span), empty: !assigned.has(bin.id) })), ...vacant]}
			selected={selected} label={m.layoutPreview} emptyLabel={m.emptyDrawer} onselect={select} edgeControls={grips}
			onswap={moving ? undefined : onswap} {onswapselect} swapLabel={m.dragDrawer} disabled={disabled || !!drag}
			onresize={resizeSelected} resizeLabel={m.resizeHandle} resizeDisabled={disabled || moving || !!drag} />
	</div>
	{#if removed}<Field.Description>{m.layoutCount(bins.length, removed)}</Field.Description>{/if}
	{#if current}
		<div class={`${formActions} my-4`}>
			<Button variant="outline" type="button" disabled={disabled || moving || !!drag || current.inner_col! + current.col_span > size.cols}
				onclick={() => resizeSelected(selected, current!.col_span + 1)} aria-label={m.widenDrawer}>+</Button>
			<Button variant="outline" type="button" disabled={disabled || moving || !!drag || assigned.has(selected) || current.col_span === 1}
				onclick={() => resizeSelected(selected, current!.col_span - 1)} aria-label={m.narrowDrawer}>−</Button>
			{#if current.row_span * current.col_span > 1}<Button variant="outline" type="button" disabled={disabled || moving || !!drag || assigned.has(selected)}
				onclick={() => change(() => splitLayout(bins, size, selected, assigned))}>{m.splitLayout}</Button>{/if}
		</div>
	{/if}
	<div aria-live="polite" aria-atomic="true">
		{#if changedRange}<span class="sr-only">{m.layoutChanged(changedRange)}</span>{/if}
	</div>
</div>
