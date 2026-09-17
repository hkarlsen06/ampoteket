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
	data-slot="card-footer"
	class={cn("bg-muted/50 relative rounded-b-xl p-(--card-spacing) flex items-center", className)}
	{...restProps}
>
	<Separator class="absolute inset-x-0 top-0" />
	{@render children?.()}
</div>
