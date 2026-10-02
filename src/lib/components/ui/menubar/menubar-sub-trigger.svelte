<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import Icon from "#lib/Icon.svelte";
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import { cn, type WithoutChild } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		inset = undefined,
		children,
		...restProps
	}: WithoutChild<MenubarPrimitive.SubTriggerProps> & {
		inset?: boolean;
	} = $props();
</script>

<MenubarPrimitive.SubTrigger
	bind:ref
	data-slot="menubar-sub-trigger"
	data-inset={inset}
	class={cn(
		"focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground min-h-11 min-w-11 gap-1.5 rounded-md border border-transparent whitespace-normal break-words data-disabled:border-dashed data-disabled:border-current data-disabled:text-muted-foreground px-1.5 py-1 text-sm data-inset:pl-7 [&_svg:not([class*='size-'])]:size-4 flex cursor-default items-center outline-none select-none",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<Icon icon={CaretRightIcon} class="cn-rtl-flip ml-auto size-4" />
</MenubarPrimitive.SubTrigger>
