<script lang="ts">
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLTableSectionElement>> = $props();
</script>

<tfoot
	bind:this={ref}
	data-slot="table-footer"
	class={cn("bg-muted/50 font-medium [&>tr>*>[data-slot=table-separator]]:top-0 [&>tr>*>[data-slot=table-separator]]:bottom-auto", className)}
	{...restProps}
>
	{@render children?.()}
</tfoot>
