<script lang="ts">
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLThAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> = $props();
</script>

<th bind:this={ref} data-slot="table-head" class={cn("text-foreground relative h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)} {...restProps}>
	{@render children?.()}
	<Separator decorative data-slot="table-separator" class="pointer-events-none absolute inset-x-0 bottom-0" />
</th>
