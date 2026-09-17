<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
	import {
		buttonVariants,
		type ButtonVariant,
		type ButtonSize,
	} from "$lib/components/ui/button/index.js";
	import { cn } from "$lib/utils.js";
	import Brackets from "$lib/Brackets.svelte";

	let {
		ref = $bindable(null),
		class: className,
		type = "button",
		variant = "default",
		size = "default",
		children,
		...restProps
	}: AlertDialogPrimitive.ActionProps & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	} = $props();
</script>

<AlertDialogPrimitive.Action
	bind:ref
	data-slot="alert-dialog-action"
	{type}
	class={cn(buttonVariants({ variant, size }), className)}
	{...restProps}
>
	{@render children?.()}
	{#if variant === "default"}<Brackets class="-inset-px" />{/if}
</AlertDialogPrimitive.Action>
