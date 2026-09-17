<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Root from './alert.svelte';
	import Description from './alert-description.svelte';

	// The common text-only composition; roles/live regions still belong to callers.
	let { ref = $bindable(null), children, ...props }: ComponentProps<typeof Root> = $props();
</script>

<Root bind:ref {...props}>
	<Description>{@render children?.()}</Description>
</Root>
