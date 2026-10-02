<script lang="ts">
	// Root layout: global styles only, so error pages outside a locale are styled too.
	// Header, footer and language come from src/routes/[[locale=locale]]/+layout.svelte.
	import '../app.css';
	import { onMount } from 'svelte';

	let { children } = $props();
	// Hydration can finish after the load event; browser proofs wait for this marker.
	onMount(() => { document.documentElement.dataset.hydrated = ''; });
</script>

{@render children()}
