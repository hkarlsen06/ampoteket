<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";

	export const alertVariants = tv({
		base: "grid gap-1 rounded-lg border px-4 py-3 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4 group/alert relative w-full",
		variants: {
			variant: {
				default: "bg-card text-card-foreground",
				destructive: "text-destructive bg-card *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
				// Needs attention, not a failure: a yellow edge marks it without colouring the text.
				warning: "bg-card text-card-foreground border-s-4 border-s-warning",
			},
			appearance: {
				default: "",
				inline: "rounded-none border-0 bg-transparent p-0",
			},
		},
		defaultVariants: {
			variant: "default",
			appearance: "default",
		},
	});

	export type AlertVariant = VariantProps<typeof alertVariants>["variant"];
	export type AlertAppearance = VariantProps<typeof alertVariants>["appearance"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		variant = "default",
		appearance = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: AlertVariant;
		appearance?: AlertAppearance;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="alert"
	role="alert"
	class={cn(alertVariants({ variant, appearance }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
