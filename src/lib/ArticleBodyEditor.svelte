<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { controlSurface } from '#lib/components/ui/control.js';
	import Icon from '#lib/Icon.svelte';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import DotsSixVerticalIcon from 'phosphor-svelte/lib/DotsSixVerticalIcon';
	import { tick, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { itemTitle } from '#lib/ui.js';
	import { cursorSlot, parseBody, placeImage, removeImage, serializeBody, slotGroups, stepSlot, type BodyBlock, type BodySlot } from '#lib/article-body.js';
	import type { ImageRef } from '#lib/admin-news.js';

	// The article text with its images placed between the lines (docs/page-news.md §4).
	// Text is edited in place; an image is dragged by its thumbnail, with a line showing
	// where it will land, or moved one place at a time with its buttons. `value` is the
	// stored body. Mount one per article ({#key}); it reads `value` once.
	let { value = $bindable(''), images, previews, id, describedBy, disabled = false }: {
		value: string; images: ImageRef[]; previews: Record<string, string | null | undefined>;
		id: string; describedBy?: string; disabled?: boolean;
	} = $props();
	const i18n = getI18n(); const m = $derived(i18n.m.adminNews);

	let blocks = $state<BodyBlock[]>(untrack(() => parseBody(value, new Set(images.map(image => image.id)))));
	let fields = $state<Record<string, HTMLTextAreaElement | null>>({});
	let frame = $state<HTMLDivElement | null>(null);
	let cursor: { key: string; at: number } | null = null;
	let announcement = $state('');
	const number = (imageId: string) => images.findIndex(image => image.id === imageId) + 1;
	const textOrdinal = (key: string) => blocks.filter(block => block.type === 'text').findIndex(block => block.key === key) + 1;

	function commit(next: BodyBlock[]) { blocks = next; value = serializeBody(next); }
	// An image taken out of the list leaves the text too.
	$effect(() => {
		const ids = new Set(images.map(image => image.id));
		const gone = blocks.filter(block => block.type === 'image' && !ids.has(block.id));
		if (gone.length) commit(gone.reduce((next, block) => removeImage(next, block.key), blocks));
	});
	// Text fields grow with their text: CSS `field-sizing` where supported, otherwise here.
	$effect(() => {
		if (CSS.supports('field-sizing', 'content')) return;
		for (const block of blocks) {
			const field = block.type === 'text' ? fields[block.key] : null;
			if (!field || block.type !== 'text') continue;
			void block.text;
			field.style.height = 'auto';
			field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
		}
	});

	/** Place an image where the cursor last was, or at the end. */
	export function insert(imageId: string) {
		const texts = blocks.filter(block => block.type === 'text');
		const block = texts.find(text => text.key === cursor?.key) ?? texts.at(-1)!;
		commit(placeImage(blocks, { id: imageId }, cursorSlot(block, cursor?.key === block.key ? cursor.at : block.text.length)));
		cursor = null;
		announcement = m.imageInserted(number(imageId));
	}
	async function step(block: Extract<BodyBlock, { type: 'image' }>, direction: -1 | 1, button: 'up' | 'down') {
		const slot = stepSlot(blocks, block.key, direction);
		if (!slot) return;
		commit(placeImage(blocks, block, slot));
		announcement = m.imageMovedInText(number(block.id));
		// Moving the row re-inserts it; keep focus on the button that moved it, or its pair at an end.
		await tick();
		const row = document.getElementById(`${id}-${block.key}`);
		const target = row?.querySelector<HTMLButtonElement>(`[data-move="${button}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)');
		target?.focus();
	}

	// ---------- Dragging ----------
	type Target = BodySlot & { y: number };
	let drag = $state<{ key: string; imageId: string; x: number; y: number; targets: Target[]; target: Target | null } | null>(null);

	/** The page y of each written line's top edge in a text field, measured on a hidden copy. */
	function lineEdges(field: HTMLTextAreaElement, lines: string[]): number[] {
		const style = getComputedStyle(field);
		const copy = document.createElement('div');
		for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'paddingTop', 'paddingRight',
			'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'] as const) copy.style[property] = style[property];
		Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-10000px', width: `${field.offsetWidth}px`, borderStyle: 'solid', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
		for (const line of lines) { const row = document.createElement('div'); row.textContent = line || '​'; copy.appendChild(row); }
		document.body.appendChild(copy);
		const top = field.getBoundingClientRect().top + scrollY + field.clientTop - field.scrollTop;
		const edges = [...copy.children].map(row => top + (row as HTMLElement).offsetTop - copy.clientTop);
		copy.remove();
		return edges;
	}
	function measure(): Target[] {
		return blocks.flatMap(block => {
			const field = block.type === 'text' ? fields[block.key] : null;
			if (block.type !== 'text' || !field) return [];
			const rect = field.getBoundingClientRect();
			const lines = block.text.split('\n');
			const edges = lineEdges(field, lines);
			const edge = (line: number) => line === 0 ? rect.top + scrollY : line === lines.length ? rect.bottom + scrollY : edges[line];
			return slotGroups(block.text).map(group => ({ textKey: block.key, at: group.at, y: group.lines.reduce((sum, line) => sum + edge(line), 0) / group.lines.length }));
		});
	}
	function aim(clientY: number) {
		if (!drag) return;
		const y = clientY + scrollY;
		drag.target = drag.targets.reduce<Target | null>((best, target) => !best || Math.abs(target.y - y) < Math.abs(best.y - y) ? target : best, null);
	}
	function startDrag(event: PointerEvent, block: Extract<BodyBlock, { type: 'image' }>) {
		if (disabled || event.button !== 0) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { key: block.key, imageId: block.id, x: event.clientX, y: event.clientY, targets: measure(), target: null };
		aim(event.clientY);
	}
	function moveDrag(event: PointerEvent) {
		if (!drag) return;
		drag.x = event.clientX; drag.y = event.clientY;
		aim(event.clientY);
	}
	function endDrag(drop: boolean) {
		if (!drag) return;
		const { key, imageId, target } = drag;
		drag = null;
		if (drop && target) { commit(placeImage(blocks, { key, id: imageId }, target)); announcement = m.imageMovedInText(number(imageId)); }
	}
	const lineTop = $derived(drag?.target && frame ? drag.target.y - (frame.getBoundingClientRect().top + scrollY) : null);
</script>

<!-- Scrolling the page while dragging (wheel or keys) keeps the line under the pointer. -->
<svelte:window onscroll={() => drag && aim(drag.y)} onkeydown={(event) => { if (drag && event.key === 'Escape') endDrag(false); }} />
<div class="grid">
<div bind:this={frame} data-slot="input-group" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}
	class={[controlSurface, 'relative grid gap-1 py-1', disabled && 'border-dashed bg-muted']}>
	{#each blocks as block (block.key)}
		{#if block.type === 'text'}
			{@const ordinal = textOrdinal(block.key)}
			<Textarea id={ordinal === 1 ? id : undefined} aria-label={ordinal === 1 ? undefined : m.bodyPart(ordinal)} data-slot="input-group-control"
				class={['resize-none rounded-none border-0 bg-transparent py-2 shadow-none disabled:bg-transparent', blocks.length === 1 ? 'min-h-48' : 'min-h-11']} rows={1} maxlength={20000}
				bind:ref={() => fields[block.key] ?? null, (field) => { fields[block.key] = field; }} bind:value={block.text} {disabled}
				oninput={() => { value = serializeBody(blocks); }}
				onblur={(blur: FocusEvent) => { cursor = { key: block.key, at: (blur.currentTarget as HTMLTextAreaElement).selectionStart }; }} />
		{:else}
			{@const n = number(block.id)}
			{@const image = images.find(item => item.id === block.id)}
			<div id={`${id}-${block.key}`} class={['mx-2 flex items-center gap-2 rounded-lg bg-muted p-2', drag?.key === block.key && 'outline-2 outline-offset-2 outline-muted-foreground outline-dashed']}>
				<!-- Dragging is pointer-only; the buttons beside it do the same one place at a time. -->
				<div data-drag-handle class={['flex shrink-0 touch-none items-center gap-1 select-none', disabled ? 'cursor-not-allowed' : drag?.key === block.key ? 'cursor-grabbing' : 'cursor-grab']} aria-hidden="true"
					onpointerdown={(event) => startDrag(event, block)} onpointermove={moveDrag} onpointerup={() => endDrag(true)} onpointercancel={() => endDrag(false)} onlostpointercapture={() => endDrag(false)}>
					<Icon icon={DotsSixVerticalIcon} size={18} class="text-muted-foreground" />
					<div class="grid size-12 place-items-center overflow-hidden rounded-md bg-card md:h-16 md:w-24">
						{#if previews[block.id]}<img src={previews[block.id]} alt="" draggable="false" class="size-full object-cover" />{/if}
					</div>
				</div>
				<div class="grid min-w-0 flex-1 gap-0.5">
					<p class={[itemTitle, 'whitespace-nowrap']}>{m.imageNumber(n)}</p>
					{#if image?.alt}<p class="truncate text-sm text-muted-foreground max-md:hidden">{image.alt}</p>{/if}
				</div>
				<div class="flex shrink-0">
					<Button type="button" variant="ghost" size="icon-sm" data-move="up" disabled={disabled || !stepSlot(blocks, block.key, -1)} onclick={() => step(block, -1, 'up')}><Icon icon={ArrowUpIcon} /><span class="sr-only">{m.moveInTextUp(n)}</span></Button>
					<Button type="button" variant="ghost" size="icon-sm" data-move="down" disabled={disabled || !stepSlot(blocks, block.key, 1)} onclick={() => step(block, 1, 'down')}><Icon icon={ArrowDownIcon} /><span class="sr-only">{m.moveInTextDown(n)}</span></Button>
					<Button type="button" variant="ghost" size="icon-sm" {disabled} onclick={() => { commit(removeImage(blocks, block.key)); announcement = m.removedFromText(n); }}><Icon icon={XIcon} /><span class="sr-only">{m.removeFromText(n)}</span></Button>
				</div>
			</div>
		{/if}
	{/each}
	{#if lineTop !== null}<div class="pointer-events-none absolute inset-x-1 z-10 h-0.5 -translate-y-1/2 rounded-full bg-ring" style:top={`${lineTop}px`} aria-hidden="true"></div>{/if}
</div>
{#if drag && previews[drag.imageId]}
	<img class="pointer-events-none fixed z-50 h-16 w-24 -translate-x-1/2 -translate-y-1/2 rounded-md object-cover shadow-card" style:left={`${drag.x}px`} style:top={`${drag.y}px`} src={previews[drag.imageId]} alt="" aria-hidden="true" />
{/if}
<p class="sr-only" aria-live="polite">{announcement}</p>
</div>
