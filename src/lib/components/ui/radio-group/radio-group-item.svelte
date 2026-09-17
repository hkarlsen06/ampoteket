<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import CircleIcon from 'phosphor-svelte/lib/CircleIcon';
	import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<RadioGroupPrimitive.ItemProps> = $props();
</script>

<RadioGroupPrimitive.Item
	bind:ref
	data-slot="radio-group-item"
	class={cn(
		"border-input bg-card data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground data-checked:border-foreground aria-invalid:aria-checked:border-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 dark:aria-invalid:border-destructive/50 flex size-6 rounded-full aria-invalid:ring-3 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input group-has-[:focus-visible]/field-label:data-checked:border-foreground group/radio-group-item peer relative aspect-square shrink-0 border outline-none after:absolute after:-inset-2.5 disabled:cursor-not-allowed disabled:border-dashed",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<div data-slot="radio-group-indicator" class="flex size-6 items-center justify-center">
			{#if checked}
				<Icon icon={CircleIcon} class="bg-background absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
			{/if}
		</div>
	{/snippet}
</RadioGroupPrimitive.Item>
