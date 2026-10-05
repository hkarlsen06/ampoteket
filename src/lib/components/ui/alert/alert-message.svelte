<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Root from './alert.svelte';
	import Description from './alert-description.svelte';

	// The common text-only composition. It sets no role: inside a live region it is announced once by the region; outside one, a dynamic error passes role="alert".
	let { ref = $bindable(null), children, ...props }: ComponentProps<typeof Root> = $props();
</script>

<Root bind:ref {...props}>
	<Description>{@render children?.()}</Description>
</Root>
