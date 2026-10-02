<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/Icon.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';

	// The one trigger for inline disclosure: a quiet button whose caret turns when
	// the content below it is open. Use inside Collapsible.Root.
	let { class: className, disabled, children }: { class?: string; disabled?: boolean; children: Snippet } = $props();
</script>

<Collapsible.Trigger {disabled}>
	{#snippet child({ props })}
		<Button {...props} type="button" variant="ghost" class={['group -ml-3 justify-start px-3', className]}>
			{@render children()}<Icon icon={CaretDownIcon} class="size-4 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180" />
		</Button>
	{/snippet}
</Collapsible.Trigger>
