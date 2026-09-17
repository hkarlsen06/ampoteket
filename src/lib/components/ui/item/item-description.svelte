<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="item-description"
	class={cn(
		"text-muted-foreground text-left text-sm leading-normal min-w-0 wrap-anywhere font-normal [&_a]:underline [&_a]:underline-offset-[0.15em] [&_a:hover]:decoration-2",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</p>
