<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import type { Snippet } from 'svelte';
	import ShelfGrip from '$lib/ShelfGrip.svelte';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
	import { Portal, Slider, Toggle } from 'bits-ui';
	import { AspectRatio } from '$lib/components/ui/aspect-ratio';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import ShelfCabinetFace from '$lib/ShelfCabinetFace.svelte';
	import { diagramRect, raaco, type CabinetInner } from '$lib/shelf-map';

	// `inner` draws a wall cabinet's drawer layout on its face.
	type Item = { id: string; row: number; col: number; rowSpan?: number; colSpan?: number; label: string; empty?: boolean; inner?: CabinetInner };
	let { rows, cols, items, selected, current, label, onselect, cabinet = false, emptyLabel = '',
		onresize, resizeLabel = '', resizeDisabled = false, responsive = false, expand = false,
		selectedIds, partialIds = [], disabled = false, onswap, onswapselect, swapLabel = '', editorGeometry = false, edgeControls }: {
		rows: number; cols: number; items: Item[];
		selected: string | null; current?: string; label: string; onselect: (id: string, event: MouseEvent | KeyboardEvent) => void;
		cabinet?: boolean; emptyLabel?: string; onresize?: (id: string, colSpan: number) => void;
		resizeLabel?: string; resizeDisabled?: boolean; responsive?: boolean; expand?: boolean;
		selectedIds?: string[]; partialIds?: string[]; disabled?: boolean;
		onswap?: (firstId: string, secondId: string) => void; onswapselect?: (id: string) => void; swapLabel?: string;
		editorGeometry?: boolean; edgeControls?: Snippet;
	} = $props();
	// Geometry is application data; button and slider behavior belongs to the library.
	// Maps draw the real cabinets in millimetres (`raaco`): one cabinet's drawers in
	// its steel frame, or the wall's cabinets touching frame to frame. The editor
	// keeps each column exactly 64px and the viewport stable instead: add the
	// frame's 2px border and 4px padding, as the height does.
	const width = $derived(editorGeometry ? cols * 64 + 6 : cabinet ? raaco.width : cols * raaco.width);
	const height = $derived(editorGeometry ? Math.max(384, rows * 25 + 6) : cabinet ? raaco.height : rows * raaco.height);
	// Frame padding plus each drawer's inset make the gutters: 2 + 2 units in the
	// editor, half a drawer gap inside a cabinet's walls, none between wall cabinets.
	const pad = $derived(editorGeometry ? { x: 2, y: 2 } : cabinet ? { x: raaco.wall - raaco.gap / 2, y: raaco.end - raaco.gap / 2 } : { x: 0, y: 0 });
	const inset = $derived(editorGeometry ? 2 : cabinet ? raaco.gap / 2 : 0);
	// Only the editor's grips hang past its frame; the margin keeps them and their focus ring unclipped.
	const margin = $derived(editorGeometry ? 8 : 0);
	const outerWidth = $derived(width + 2 * margin), outerHeight = $derived(height + 2 * margin);
	const gridWidth = $derived(width - 2 * pad.x), gridHeight = $derived(height - 2 * pad.y);
	const cellWidth = $derived(gridWidth / cols), cellHeight = $derived(gridHeight / rows);
	// Handles and outlines sit in the frame's padding box, while drawers fill its
	// content box (inset by the frame padding): map a 0–1 fraction of the grid to
	// CSS so they meet the drawer edges exactly. Padding is in cqw on both axes.
	const padX = $derived(`${pad.x / outerWidth * 100}cqw`), padY = $derived(`${pad.y / outerWidth * 100}cqw`);
	const at = (fraction: number, framePad = padX) => `calc(${framePad} + (100% - 2 * ${framePad}) * ${fraction})`;
	const span = (fraction: number, framePad = padX) => `calc((100% - 2 * ${framePad}) * ${fraction})`;
	// Dense layouts pan inside a named region instead of shrinking their targets.
	// Include the frame's 2px border and a 1px cell rounding allowance.
	const minimumWidth = $derived(editorGeometry ? outerWidth : (Math.max(cols / gridWidth, rows / gridHeight) * 25 * width + 2) * outerWidth / width);
	const chosen = $derived(items.find((item) => item.id === selected));
	let diagram = $state<HTMLDivElement | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);
	let focusedId = $state<string | null>(null);
	const visualOrder = $derived([...items].sort((a, b) =>
		(b.row + (b.rowSpan ?? 1)) - (a.row + (a.rowSpan ?? 1)) || a.col - b.col || a.id.localeCompare(b.id)));
	const tabId = $derived(items.some((item) => item.id === focusedId) ? focusedId
		: chosen?.id ?? items.find((item) => item.id === current)?.id ?? visualOrder[0]?.id);
	let preview = $state<{ id: string; width: number } | null>(null);
	let sliderGeneration = $state(0);
	const shownWidth = $derived(preview?.id === chosen?.id ? preview?.width ?? 1 : chosen?.colSpan ?? 1);
	$effect(() => {
		if (preview && (disabled || resizeDisabled || chosen?.id !== preview.id)) preview = null;
	});
	let drag = $state<{ id: string; pointer: number; x: number; y: number; moved: boolean; target: string | null; handle: HTMLElement; left: number; top: number; width: number; height: number; fontSize: string; label: string; dx: number; dy: number } | null>(null);
	let dragged = false;
	$effect(() => {
		if (drag && (disabled || !onswap || !items.some((item) => item.id === drag!.id))) cancelDrag();
	});
	function cancelDrag() {
		const previous = drag;
		drag = null;
		if (previous?.handle.hasPointerCapture(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer);
	}
	function startDrag(event: PointerEvent, id: string) {
		if (disabled || !onswap || event.button !== 0 || !event.isPrimary || drag) return;
		const cell = Array.from(diagram?.querySelectorAll<HTMLElement>('[data-item-id]') ?? []).find((element) => element.dataset.itemId === id);
		const drawer = cell?.querySelector<HTMLElement>('.drawer');
		if (!drawer) return;
		const bounds = drawer.getBoundingClientRect();
		dragged = false;
		const handle = event.currentTarget as HTMLElement;
		drag = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null, handle,
			left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
			fontSize: getComputedStyle(drawer).fontSize, label: items.find((item) => item.id === id)!.label, dx: 0, dy: 0 };
		handle.setPointerCapture(event.pointerId);
	}
	function moveDrag(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointer) return;
		drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6;
		if (!drag.moved) return;
		dragged = true;
		drag.dx = event.clientX - drag.x; drag.dy = event.clientY - drag.y;
		const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-item-id]');
		drag.target = target && diagram?.contains(target) && target.dataset.itemId !== drag.id ? target.dataset.itemId ?? null : null;
	}
	function finishDrag(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointer) return;
		moveDrag(event);
		const completed = drag;
		cancelDrag();
		if (!disabled && completed.moved && completed.target && items.some((item) => item.id === completed.target)) onswap?.(completed.id, completed.target);
	}
	function cancelResize() {
		// Bits owns the drag, but its document listeners do not handle pointercancel.
		// Remounting releases that interaction without committing a cancelled preview.
		preview = null;
		sliderGeneration += 1;
	}
	function rect(item: Item, colSpan = item.colSpan ?? 1) {
		const value = diagramRect(rows, item.row, item.col, item.rowSpan, colSpan);
		return { x: value.x * cellWidth, y: value.y * cellHeight, width: value.width * cellWidth, height: value.height * cellHeight };
	}
	function select(id: string, event: MouseEvent | KeyboardEvent) {
		if (disabled || (event instanceof MouseEvent && event.detail > 0 && dragged)) return;
		focusedId = id; onselect(id, event);
	}
	function reveal(element: HTMLElement) {
		// Reveal focus within the diagram and any containing sheet. Never pan
		// the document or animate keyboard moves.
		for (let region: HTMLElement | null = viewport; region && region !== document.body; region = region.parentElement) {
			if (!/(auto|scroll)/.test(getComputedStyle(region).overflow)) continue;
			const frame = region.getBoundingClientRect(), target = element.getBoundingClientRect();
			if (target.left < frame.left + 4) region.scrollLeft -= frame.left + 4 - target.left;
			else if (target.right > frame.right - 4) region.scrollLeft += target.right - frame.right + 4;
			if (target.top < frame.top + 4) region.scrollTop -= frame.top + 4 - target.top;
			else if (target.bottom > frame.bottom - 4) region.scrollTop += target.bottom - frame.bottom + 4;
		}
	}
	function neighbour(id: string, direction: string): Item | undefined {
		const source = items.find((item) => item.id === id);
		if (!source) return;
		const box = rect(source), horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
		const forward = direction === 'ArrowRight' || direction === 'ArrowDown';
		const start = horizontal ? box.x : box.y, end = start + (horizontal ? box.width : box.height);
		const crossStart = horizontal ? box.y : box.x, crossEnd = crossStart + (horizontal ? box.height : box.width);
		return items.filter((item) => item.id !== id).map((item) => {
			const other = rect(item), otherStart = horizontal ? other.x : other.y;
			const otherEnd = otherStart + (horizontal ? other.width : other.height);
			const otherCrossStart = horizontal ? other.y : other.x;
			const otherCrossEnd = otherCrossStart + (horizontal ? other.height : other.width);
			const gap = forward ? otherStart - end : start - otherEnd;
			const overlap = Math.min(crossEnd, otherCrossEnd) - Math.max(crossStart, otherCrossStart);
			return { item, gap, aligned: overlap > 0, distance: gap ** 2 + Math.max(0, -overlap) ** 2,
				centre: Math.abs((crossStart + crossEnd) - (otherCrossStart + otherCrossEnd)) };
		}).filter((candidate) => candidate.gap >= -0.001)
			.sort((a, b) => Number(b.aligned) - Number(a.aligned) || a.distance - b.distance || a.centre - b.centre
				|| visualOrder.indexOf(a.item) - visualOrder.indexOf(b.item))[0]?.item;
	}
	function key(event: KeyboardEvent, id: string) {
		if (disabled) return;
		// Shift ranges need the original keyboard modifiers. Ordinary activation
		// belongs to the native button supplied by Bits UI.
		if (event.shiftKey && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(id, event); return; }
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const next = event.key === 'Home' ? visualOrder[0] : event.key === 'End' ? visualOrder.at(-1) : neighbour(id, event.key);
		if (!next) return;
		focusedId = next.id;
		const element = Array.from(diagram?.querySelectorAll<HTMLButtonElement>('[data-item-id]') ?? []).find((node) => node.dataset.itemId === next.id);
		element?.focus({ preventScroll: true });
	}
	function resize(value: number) {
		if (chosen && !disabled && !resizeDisabled) onresize?.(chosen.id, value);
		// Rejected domain changes leave the original width and identity visible.
		preview = null;
	}
</script>

<svelte:window onpointermove={moveDrag} onpointerup={finishDrag}
	onpointercancel={() => { cancelResize(); cancelDrag(); }}
	onkeydown={(event) => { if (event.key === 'Escape' && (drag || preview)) { event.preventDefault(); cancelDrag(); cancelResize(); } }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex (The named shelf viewport supports native keyboard scrolling.) -->
<!-- Grips hang ~14px past the diagram; 20px padding (p-5) keeps them and their
     4px focus ring unclipped while a standard cabinet still fits a 360px phone.
     A bounded responsive diagram is capped at the width whose height fits the
     region, so a tall cabinet shows whole instead of panning.
     `expand` trades the bounded interior scroll region for document flow: the
     diagram takes its full height and the surrounding card grows to fit. -->
<div bind:this={viewport} class={`shelf-viewport mx-auto w-full min-w-0 overflow-auto overscroll-contain ${onswap || edgeControls ? 'p-5' : 'p-1'}${editorGeometry ? ' h-112 max-h-[min(28rem,70dvh)]' : expand ? '' : ' max-h-[min(32rem,70dvh)]'}`}
	role="region" aria-label={label} tabindex="0"
	style:max-width={editorGeometry ? `${outerWidth + (onswap || edgeControls ? 40 : 8)}px`
		: !responsive ? `calc(${20 * outerWidth / outerHeight}rem + ${onswap ? 2.5 : 0.5}rem)`
		: expand ? undefined : `calc((min(32rem, 70dvh) - 0.5rem) * ${outerWidth / outerHeight} + 0.5rem)`}>
<div bind:this={diagram} class="shelf-diagram @container w-full" data-resizing={preview ? 'true' : undefined} role="group" aria-label={label}
	style:min-width={`${minimumWidth}px`} style:width={editorGeometry ? `${outerWidth}px` : undefined}>
	<AspectRatio ratio={outerWidth / outerHeight}>
		<!-- Gutter model: the frame pads `pad` and each drawer insets `inset`
		     units per side, so drawer↔drawer gaps are 2 × inset and drawer↔frame
		     gaps pad + inset. Padding uses cqw so both axes use the same unit
		     (percentage padding would resolve both against width of the frame,
		     and inset percentages resolve per axis). The wall has no frame of its
		     own: its cabinets are the steel. -->
		<div class={cn('cabinet-frame absolute grid', cabinet && 'rounded-sm border border-steel-seam bg-steel')} data-zoom-frame
			style:padding={`${padY} ${padX}`}
			style:inset={`${margin / outerHeight * 100}% ${margin / outerWidth * 100}%`}
			style:grid-template-columns={`repeat(${cols}, minmax(0, 1fr))`}
			style:grid-template-rows={`repeat(${rows}, minmax(0, 1fr))`}>
			{#each visualOrder as item (item.id)}
				{@const box = rect(item)}
				{@const active = selectedIds ? selectedIds.includes(item.id) : selected === item.id}
				{@const partial = partialIds.includes(item.id)}
				<Toggle.Root bind:pressed={() => active, () => {}} {disabled}
					onclick={(event) => select(item.id, event)} onkeydown={(event) => key(event, item.id)}>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" data-item-id={item.id}
							class={['cell-hit group/cell relative h-full min-h-0 w-full min-w-0 rounded-none border-0 bg-transparent p-0 font-mono font-normal text-foreground hover:bg-transparent active:not-aria-[haspopup]:translate-y-0', item.empty && 'empty', active && 'selected', partial && 'partial', current === item.id && 'current', onswap && !disabled && 'touch-none cursor-grab', drag?.id === item.id && drag.moved && 'cursor-grabbing border border-dashed border-muted-foreground']}
							tabindex={!disabled && tabId === item.id ? 0 : -1}
							aria-current={current === item.id ? 'true' : undefined}
							aria-label={item.empty && emptyLabel ? `${item.label} · ${emptyLabel}` : item.label}
							aria-pressed={partial ? 'mixed' : active}
							onpointerdown={(event) => { if (onswap) startDrag(event, item.id); }} onlostpointercapture={cancelDrag}
								onfocus={(event) => { focusedId = item.id; reveal(event.currentTarget); }}
							style={`grid-column: ${item.col} / span ${item.colSpan ?? 1}; grid-row: ${rows - item.row - (item.rowSpan ?? 1) + 2} / span ${item.rowSpan ?? 1};`}>
							<!-- Assigned drawers are filled fronts with a label strip, as the
							     real drawers carry one; unassigned drawers are hollow. Wall
							     cabinets are steel faces. -->
							<span class={cn('drawer absolute flex flex-col items-center justify-center gap-[0.25em] rounded-xs border transition-colors group-hover/cell:border-foreground', cabinet ? 'border-drawer-edge bg-drawer' : 'rounded-none border-steel-seam bg-steel', item.empty && 'bg-transparent text-muted-foreground', active && 'border-2 border-foreground', partial && 'border-2 border-dashed border-foreground', current === item.id && 'border-2 border-warning ring-2 ring-[var(--focus-contrast)]', drag?.id === item.id && drag.moved && 'invisible', drag?.target === item.id && 'outline-3 outline-dashed outline-foreground outline-offset-2')}
								aria-hidden="true" data-zoom-face={item.id}
								style:inset-block={`${inset / box.height * 100}%`}
								style:inset-inline={`${inset / box.width * 100}%`}
								style:font-size={`clamp(0.5rem, ${Math.min(box.height * .45, box.width / (item.label.length * .8)) / outerWidth * 100}cqw, 0.875rem)`}>
								{#if !cabinet}<ShelfCabinetFace label={item.label} inner={item.inner} />
								{:else}<span class={['h-[0.2em] w-[2em] rounded-full bg-drawer-edge', item.empty && 'invisible']}></span>{item.label}{/if}
								{#if selectedIds && (active || partial)}
									{#if partial}<Icon icon={MinusIcon} class="absolute top-0.5 left-0.5 size-2" />{:else}<Icon icon={CheckIcon} class="absolute top-0.5 left-0.5 size-2" />{/if}
								{/if}
							</span>
						</Button>
					{/snippet}
				</Toggle.Root>
			{/each}
			{#if chosen && onswap}
				{@const box = rect(chosen)}
				<Button variant="ghost" size="icon" class={cn('drawer-move-handle absolute z-20 size-11 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full active:not-aria-[haspopup]:-translate-y-1/2', drag ? 'cursor-grabbing' : 'cursor-grab', drag?.moved && 'invisible')}
					style={`left: ${at(box.x / gridWidth)}; top: ${at(box.y / gridHeight, padY)};`}
					aria-label={swapLabel} {disabled} onpointerdown={(event) => { if (chosen) startDrag(event, chosen.id); }}
					onlostpointercapture={cancelDrag}
					onclick={(event) => { if (!disabled && chosen && (!dragged || event.detail === 0)) onswapselect?.(chosen.id); }}>
					<span class="flex size-7 items-center justify-center rounded-sm border border-foreground bg-card text-card-foreground"><ShelfGrip /></span>
				</Button>
			{/if}
			{#if chosen && onresize}
				{@const box = rect(chosen, shownWidth)}
				{@const maximum = cols - chosen.col + 1}
				{#if preview?.id === chosen.id && !resizeDisabled}
					<div aria-hidden="true" class="pointer-events-none absolute z-10 border-2 border-dashed border-foreground"
						style:left={at(box.x / gridWidth)} style:top={at(box.y / gridHeight, padY)}
						style:width={span(box.width / gridWidth)} style:height={span(box.height / gridHeight, padY)}></div>
				{/if}
				<!-- An exact-position Bits slider follows the drawer's right edge.
				     It owns pointer tracking, keyboard steps and accessible value state. -->
				{#key `${chosen.id}:${disabled}:${resizeDisabled}:${sliderGeneration}`}
				<Slider.Root type="single" min={1} max={maximum} step={1} thumbPositioning="exact"
					bind:value={() => shownWidth, value => { preview = { id: chosen!.id, width: value }; }}
					onValueCommit={resize} disabled={disabled || resizeDisabled || maximum === 1}
					class={cn("pointer-events-none absolute z-20 h-0", drag?.moved && 'invisible')}
					style={`left: ${at((box.x + cellWidth) / gridWidth)}; top: ${at((box.y + box.height) / gridHeight, padY)}; width: ${span((maximum - 1) * cellWidth / gridWidth)};`}>
					<Slider.Thumb index={0} aria-label={resizeLabel}
						class="resize-handle pointer-events-auto -mt-5.5 flex size-11 cursor-ew-resize items-center justify-center rounded-full data-disabled:cursor-default">
						<span class="flex size-7 items-center justify-center rounded-sm border border-foreground bg-card text-card-foreground"><ShelfGrip /></span>
					</Slider.Thumb>
				</Slider.Root>
				{/key}
			{/if}
			{@render edgeControls?.()}
		</div>
	</AspectRatio>
</div>
</div>

{#if drag?.moved}
	<!-- Escape clipping and transformed sheet ancestors; never intercept the drop target. -->
	<Portal>
		<div data-drawer-drag-preview aria-hidden="true"
			class="pointer-events-none fixed z-[60] flex items-center justify-center border-2 border-foreground bg-card font-mono text-foreground shadow-card"
			style:left={`${drag.left + drag.dx}px`} style:top={`${drag.top + drag.dy}px`}
			style:width={`${drag.width}px`} style:height={`${drag.height}px`} style:font-size={drag.fontSize}>
			{drag.label}
		</div>
	</Portal>
{/if}
