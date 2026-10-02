<script lang="ts">
	import { Separator } from "#lib/components/ui/separator/index.js";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		layout = "stack",
		density = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { layout?: "stack" | "bar"; density?: "default" | "compact" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="dialog-header"
	class={cn("min-w-0 gap-2 flex flex-col", layout === "bar" && "relative flex-row items-center justify-between gap-3 px-4 py-3 md:px-6 [&>button]:shrink-0", density === "compact" && "py-2 pr-3", className)}
	{...restProps}
>
	{@render children?.()}
	{#if layout === "bar"}<Separator class="absolute inset-x-0 bottom-0" />{/if}
</div>
