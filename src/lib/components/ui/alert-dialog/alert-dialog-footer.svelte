<script lang="ts">
	import { Separator } from "$lib/components/ui/separator/index.js";
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
	data-slot="alert-dialog-footer"
	class={cn(
		"bg-muted/50 relative -mx-4 -mb-4 rounded-b-xl p-4 flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 md:flex-row md:justify-end",
		className
	)}
	{...restProps}
>
	<Separator class="absolute inset-x-0 top-0" />
	{@render children?.()}
</div>
