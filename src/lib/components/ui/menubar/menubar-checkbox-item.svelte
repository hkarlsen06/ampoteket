<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import Icon from "#lib/Icon.svelte";
	import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import { cn, type WithoutChildrenOrChild } from "#lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		indeterminate = $bindable(false),
		inset,
		children: childrenProp,
		...restProps
	}: WithoutChildrenOrChild<MenubarPrimitive.CheckboxItemProps> & {
		inset?: boolean;
		children?: Snippet;
	} = $props();
</script>

<MenubarPrimitive.CheckboxItem
	bind:ref
	bind:checked
	bind:indeterminate
	data-slot="menubar-checkbox-item"
	data-inset={inset}
	class={cn(
		"focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground min-h-11 min-w-11 gap-1.5 rounded-md border border-transparent whitespace-normal break-words data-disabled:border-dashed data-disabled:border-current data-disabled:text-muted-foreground py-1 pr-1.5 pl-7 text-sm data-inset:pl-7 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked: checked, indeterminate: indeterminate })}
		<span
			class="left-1.5 size-4 [&_svg:not([class*='size-'])]:size-4 pointer-events-none absolute flex items-center justify-center"
		>
			{#if indeterminate}
				<Icon icon={MinusIcon} />
			{:else if checked}
				<Icon icon={CheckIcon} />
			{/if}
		</span>
		{@render childrenProp?.()}
	{/snippet}
</MenubarPrimitive.CheckboxItem>
