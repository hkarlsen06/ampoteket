<script lang="ts">
	import { cn } from '$lib/utils';

	// Instrument-frame corner marks: four L-shaped ticks around the nearest
	// positioned ancestor. Artwork, not a boundary; colour follows currentColor.
	let { class: className }: { class?: string } = $props();
	const corner = 'absolute size-2.5 border-current';
</script>

<span class={cn('pointer-events-none absolute inset-0', className)} aria-hidden="true">
	<span class="{corner} top-0 left-0 border-t-2 border-l-2"></span>
	<span class="{corner} top-0 right-0 border-t-2 border-r-2"></span>
	<span class="{corner} right-0 bottom-0 border-r-2 border-b-2"></span>
	<span class="{corner} bottom-0 left-0 border-b-2 border-l-2"></span>
</span>
