<script lang="ts">
	import { controlStyles } from "$lib/components/ui/control";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	}: Props = $props();
	const classes = $derived(cn(controlStyles, "h-12 px-3 py-2 file:mr-3 file:inline-flex file:h-8 file:items-center file:rounded-md file:border-0 file:bg-muted file:px-2 file:text-sm file:font-medium file:text-foreground disabled:pointer-events-none", className));
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={classes}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={classes}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
