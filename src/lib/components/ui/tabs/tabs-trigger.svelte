<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: TabsPrimitive.TriggerProps = $props();
</script>

<TabsPrimitive.Trigger
	bind:ref
	data-slot="tabs-trigger"
	class={cn(
		"relative inline-flex min-h-11 min-w-0 max-w-full flex-none items-center justify-center rounded-md border border-transparent px-3 py-2 text-base font-medium whitespace-normal text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:border-dashed disabled:border-current",
		"data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:underline data-[state=active]:underline-offset-4 data-[state=active]:shadow-sm",
		className
	)}
	{...restProps}
/>
