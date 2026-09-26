<script lang="ts">
	import { controlStyles } from "$lib/components/ui/control";
	import { cn, type WithElementRef, type WithoutChildren } from "$lib/utils.js";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "textarea",
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(controlStyles, "flex field-sizing-content min-h-24 px-3 py-2", className)}
	inputmode="text"
	autocapitalize="sentences"
	autocomplete="off"
	enterkeyhint="enter"
	bind:value
	{...restProps}></textarea>
