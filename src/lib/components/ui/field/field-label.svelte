<script lang="ts">
	import { Label } from "$lib/components/ui/label/index.js";
	import { cn } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children,
		required = false,
		...restProps
	}: ComponentProps<typeof Label> & { required?: boolean } = $props();
</script>

<Label
	bind:ref
	data-slot="field-label"
	class={cn(
		"has-data-checked:bg-foreground/5 has-data-checked:border-foreground/30 dark:has-data-checked:border-foreground/20 dark:has-data-checked:bg-foreground/10 gap-2 leading-snug  has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 *:data-[slot=field]:p-2.5 group/field-label peer/field-label flex w-fit",
		"has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<!-- Visual cue only; the control's own required attribute is announced. -->
	{#if required}<span aria-hidden="true" class="-ms-1 text-destructive">*</span>{/if}
</Label>
