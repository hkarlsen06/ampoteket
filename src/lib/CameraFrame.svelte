<script lang="ts">
	import { getI18n } from '#lib/i18n/index.js';

	// The staff scanners' viewfinder: live preview, hidden decode canvas and aiming
	// frame. The caller owns the camera session and binds both elements.
	let { video = $bindable(), canvas = $bindable() }: { video?: HTMLVideoElement; canvas?: HTMLCanvasElement } = $props();
	const i18n = getI18n();
</script>

<div class="relative mx-auto aspect-square w-[min(100%,12rem)] overflow-hidden rounded-lg bg-secondary">
	<video class="absolute inset-0 size-full object-cover" bind:this={video} autoplay muted playsinline aria-label={i18n.m.scanner.preview}></video>
	<canvas class="hidden" bind:this={canvas} aria-hidden="true"></canvas>
	<div class="pointer-events-none absolute inset-[10%] border-2 border-foreground" aria-hidden="true"></div>
</div>
