<script lang="ts">
	import { Separator } from "#lib/components/ui/separator/index.js";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLTdAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTdAttributes> = $props();
</script>

<td bind:this={ref} data-slot="table-cell" class={cn("relative p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)} {...restProps}>
	{@render children?.()}
	<Separator decorative data-slot="table-separator" class="pointer-events-none absolute inset-x-0 bottom-0" />
</td>
