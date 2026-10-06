<script lang="ts">
	// A wall cabinet's front: its real drawer layout in miniature under the address
	// on a small tag. Decorative; the containing control is the steel face and
	// carries the accessible name.
	import { drawerFront, raaco, type CabinetInner } from '#lib/shelf-map.js';

	let { label, inner }: { label: string; inner?: CabinetInner } = $props();
</script>

{#if inner}
	<!-- One scaled drawing, not a box per drawer: separate boxes snap to whole
	     pixels and turn the hairline gaps uneven. -->
	<svg aria-hidden="true" class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 {raaco.width} {raaco.height}" preserveAspectRatio="none">
		{#each inner.drawers as drawer, index (index)}
			{@const front = drawerFront(inner.rows, inner.cols, drawer.row, drawer.col, drawer.rowSpan, drawer.colSpan)}
			{@const marked = inner.marked?.row === drawer.row && inner.marked.col === drawer.col}
			<rect class={marked ? 'marked-drawer fill-warning' : 'fill-drawer'} x={front.x * raaco.width} y={front.y * raaco.height} width={front.width * raaco.width} height={front.height * raaco.height} />
		{/each}
	</svg>
{/if}
{#if !inner?.marked}<span class="relative rounded-xs border border-steel-seam bg-card px-[0.4em] leading-normal text-foreground">{label}</span>{/if}
