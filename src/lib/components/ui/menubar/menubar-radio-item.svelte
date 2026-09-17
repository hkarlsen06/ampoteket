<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import Icon from "$lib/Icon.svelte";
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import { cn, type WithoutChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		children: childrenProp,
		...restProps
	}: WithoutChild<MenubarPrimitive.RadioItemProps> & {
		inset?: boolean;
	} = $props();
</script>

<MenubarPrimitive.RadioItem
	bind:ref
	data-slot="menubar-radio-item"
	data-inset={inset}
	class={cn(
		"focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground min-h-11 min-w-11 gap-1.5 rounded-md border border-transparent whitespace-normal break-words data-disabled:border-dashed data-disabled:border-current data-disabled:text-muted-foreground py-1 pr-1.5 pl-7 text-sm data-inset:pl-7 [&_svg:not([class*='size-'])]:size-4 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<span
			class="left-1.5 size-4 [&_svg:not([class*='size-'])]:size-4 pointer-events-none absolute flex items-center justify-center"
		>
			{#if checked}
				<Icon icon={CheckIcon} />
			{/if}
		</span>
		{@render childrenProp?.({ checked })}
	{/snippet}
</MenubarPrimitive.RadioItem>
