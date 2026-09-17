<script lang="ts" module>
	import { tv, type VariantProps } from "tailwind-variants";

	export const fieldVariants = tv({
		base: "data-[invalid=true]:text-destructive gap-2 group/field flex w-full",
		variants: {
			width: {
				full: "min-w-0",
				grow: "min-w-0 w-auto flex-[99_1_16rem]",
				short: "min-w-0 w-auto max-w-40 flex-[1_1_6rem]",
				medium: "min-w-0 w-auto max-w-68 flex-[1_1_10rem]",
			},
			orientation: {
				vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
				horizontal:
					"min-h-11 flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
				responsive:
					"flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
			},
		},
		defaultVariants: {
			width: "full",
			orientation: "vertical",
		},
	});

	export type FieldOrientation = VariantProps<typeof fieldVariants>["orientation"];
	export type FieldWidth = VariantProps<typeof fieldVariants>["width"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		orientation = "vertical",
		width = "full",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		orientation?: FieldOrientation;
		width?: FieldWidth;
	} = $props();
</script>

<div
	bind:this={ref}
	role="group"
	data-slot="field"
	data-orientation={orientation}
	class={cn(fieldVariants({ orientation, width }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
