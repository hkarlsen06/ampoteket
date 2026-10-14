<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import Icon from '#lib/Icon.svelte';
	import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

	// Advice next to a field that never blocks saving (an unlikely value, a probable
	// duplicate, an untranslated name). The live region stays mounted so a warning that
	// appears later is announced; empty, it leaves the flow, so it adds no gap.
	// Reference `id` from the field's aria-describedby while `show` is true.
	let { id, show, class: className, children }: { id: string; show: boolean; class?: string; children: Snippet } = $props();
</script>

<div {id} aria-live="polite" class={['[&:not(:has(*))]:absolute [&:not(:has(*))]:w-0!', className]}>
	{#if show}
		<Alert.Root variant="warning" appearance="inline">
			<Icon icon={WarningIcon} />
			<Alert.Description class="text-foreground">{@render children()}</Alert.Description>
		</Alert.Root>
	{/if}
</div>
