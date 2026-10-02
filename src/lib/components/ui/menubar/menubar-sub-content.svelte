<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.SubContentProps = $props();
</script>

<MenubarPrimitive.SubContent
	bind:ref
	data-slot="menubar-sub-content"
	class={cn(
		"bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 ring-foreground/10 min-w-32 rounded-lg p-1 shadow-lg ring-1 duration-100 z-50 origin-(--bits-menubar-content-transform-origin) max-w-[calc(100vw-2rem)]",
		className
	)}
	{...restProps}
/>
