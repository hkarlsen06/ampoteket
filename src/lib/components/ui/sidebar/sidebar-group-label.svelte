<script lang="ts">
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="sidebar-group-label"
	data-sidebar="group-label"
	class={cn("px-2 pt-2 pb-1 text-sm font-semibold text-muted-foreground group-data-[collapsible=icon]:hidden", className)}
	{...restProps}
>
	{@render children?.()}
</div>
