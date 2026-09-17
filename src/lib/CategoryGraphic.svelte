<script lang="ts">
	import { AspectRatio } from '$lib/components/ui/aspect-ratio';
	let { category }: { category: string | null } = $props();
	const kind = $derived(category?.trim().toLowerCase());
	const names = new Set(['resistors', 'capacitors', 'diodes', 'leds', 'transistors', 'controllers', 'sensors', 'motors', 'connectors', 'prototyping', 'cable']);
	const image = $derived(kind === 'bipolar transistors' || kind === 'mosfets' ? 'transistors' : kind === 'motor drivers' ? 'motor-drivers' : kind && names.has(kind) ? kind : 'miscellaneous');
</script>

<!-- Decorative family image; the adjacent product text identifies the exact part. -->
<AspectRatio ratio={5 / 3}>
	<img class="block size-full object-contain dark:[filter:drop-shadow(.5px_0_0_var(--paper))_drop-shadow(-.5px_0_0_var(--paper))_drop-shadow(0_.5px_0_var(--paper))_drop-shadow(0_-.5px_0_var(--paper))]" src={`/components/${image}.webp`} alt="" width="240" height="144" loading="lazy" decoding="async" />
</AspectRatio>
