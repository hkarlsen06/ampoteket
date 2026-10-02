<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		"aria-label": label,
		"aria-labelledby": labelledby,
		...restProps
	}: AlertDialogPrimitive.DescriptionProps = $props();
</script>

<!-- Keep the region name off the warning itself, which describes the dialog. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex (The named region supports keyboard scrolling.) -->
<div role="region" aria-label={label} aria-labelledby={labelledby} tabindex="0" class="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
	<AlertDialogPrimitive.Description
		bind:ref
		data-slot="alert-dialog-description"
		class={cn("text-muted-foreground *:[a]:hover:text-foreground text-sm text-balance md:text-pretty *:[a]:underline *:[a]:underline-offset-3", className)}
		{...restProps}
	/>
</div>
