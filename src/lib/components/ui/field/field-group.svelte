<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		layout = "stack",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { layout?: "stack" | "row" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="field-group"
	class={cn(
		"gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4 group/field-group @container/field-group flex w-full flex-col",
		layout === "row" && "flex-row flex-wrap items-end gap-x-5 gap-y-4",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
