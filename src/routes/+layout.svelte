<script lang="ts">
	// Root layout: global styles only, so error pages outside a locale are styled too.
	// Header, footer and language come from src/routes/[[locale=locale]]/+layout.svelte.
	import '../app.css';

	let { children } = $props();
</script>

{@render children()}
