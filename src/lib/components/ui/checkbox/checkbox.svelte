<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
	import { Checkbox as CheckboxPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	data-slot="checkbox"
	class={cn(
		"border-input bg-card data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground data-checked:border-foreground aria-invalid:aria-checked:border-foreground aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 flex size-6 items-center justify-center rounded-sm border transition-colors aria-invalid:ring-3 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input group-has-[:focus-visible]/field-label:data-checked:border-foreground peer relative shrink-0 outline-none after:absolute after:-inset-2.5 disabled:cursor-not-allowed disabled:border-dashed",
		className
	)}
	bind:checked
	bind:indeterminate
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<div
			data-slot="checkbox-indicator"
			class="[&>svg]:size-3.5 grid place-content-center text-current transition-none"
		>
			{#if checked}
				<Icon icon={CheckIcon} />
			{:else if indeterminate}
				<Icon icon={MinusIcon}  />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
