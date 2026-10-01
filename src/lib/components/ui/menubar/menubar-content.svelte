<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import MenubarPortal from "./menubar-portal.svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 8,
		alignOffset = -4,
		align = "start",
		side = "bottom",
		portalProps,
		...restProps
	}: MenubarPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof MenubarPortal>>;
	} = $props();
</script>

<MenubarPortal {...portalProps}>
	<MenubarPrimitive.Content
		bind:ref
		data-slot="menubar-content"
		{align}
		{alignOffset}
		{side}
		{sideOffset}
		class={cn(
			"bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 ring-foreground/10 min-w-36 rounded-lg p-1 shadow-md ring-1 duration-100 z-50 origin-(--bits-menubar-content-transform-origin) max-w-[calc(100vw-2rem)]",
			className
		)}
		{...restProps}
	/>
</MenubarPortal>
