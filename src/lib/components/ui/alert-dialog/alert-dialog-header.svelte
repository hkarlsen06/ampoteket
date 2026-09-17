<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
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
	data-slot="alert-dialog-header"
	class={cn("grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center md:group-data-[size=default]/alert-dialog-content:place-items-start md:group-data-[size=default]/alert-dialog-content:text-left", className)}
	{...restProps}
>
	{@render children?.()}
</div>
