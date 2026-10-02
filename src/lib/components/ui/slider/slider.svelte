<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = "horizontal",
		class: className,
		thumbProps,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & { thumbProps?: (index: number) => Pick<SliderPrimitive.ThumbProps, "id" | "aria-label" | "aria-valuetext"> } = $props();
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	data-slot="slider"
	{orientation}
	class={cn(
		"group/slider data-vertical:min-h-40 relative flex min-h-11 w-full touch-none items-center select-none data-disabled:cursor-not-allowed data-vertical:h-full data-vertical:w-auto data-vertical:flex-col",
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			class={cn(
				"bg-muted rounded-full group-data-disabled/slider:bg-transparent group-data-disabled/slider:border group-data-disabled/slider:border-dashed group-data-disabled/slider:border-muted-foreground data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1 relative grow overflow-hidden data-horizontal:w-full data-vertical:h-full"
			)}
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				class={cn(
					"bg-foreground absolute select-none data-horizontal:h-full data-vertical:w-full"
				)}
			/>
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				{...thumbProps?.(thumb.index)}
				class="border-foreground relative size-6 rounded-full border-2 bg-background transition-[color,box-shadow] after:absolute after:-inset-2.5 focus-visible:outline-hidden block shrink-0 select-none data-disabled:pointer-events-none data-disabled:border-dashed data-disabled:border-muted-foreground"
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
