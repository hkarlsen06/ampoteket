<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		showCloseButton = false,
		closeLabel,
		variant = "center",
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		showCloseButton?: boolean;
		closeLabel?: string;
		/** `sheet`: the action row at the bottom of a `Dialog.Content variant="sheet"`. */
		variant?: "center" | "sheet";
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="dialog-footer"
	class={cn("bg-muted/50 relative -mx-4 -mb-4 rounded-b-xl p-4 flex flex-col-reverse gap-2 md:flex-row md:justify-end", variant === "sheet" && "m-0 flex-row flex-wrap justify-end gap-3 rounded-none px-4 py-4 md:px-6", className)}
	{...restProps}
>
	<Separator class="absolute inset-x-0 top-0" />
	{@render children?.()}
	{#if showCloseButton && closeLabel}
		<DialogPrimitive.Close>
			{#snippet child({ props })}
				<Button variant="outline" {...props}>{closeLabel}</Button>
			{/snippet}
		</DialogPrimitive.Close>
	{/if}
</div>
