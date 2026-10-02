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
	data-slot="empty-description"
	class={cn(
		"text-sm/relaxed text-muted-foreground [&_a]:underline [&_a]:underline-offset-[0.15em] [&_a:hover]:decoration-2",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
