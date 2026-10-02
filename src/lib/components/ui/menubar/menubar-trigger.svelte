<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.TriggerProps = $props();
</script>

<MenubarPrimitive.Trigger
	bind:ref
	data-slot="menubar-trigger"
	class={cn("hover:bg-muted aria-expanded:bg-muted min-h-11 min-w-11 rounded-sm border border-transparent px-3 py-2 whitespace-normal disabled:border-dashed disabled:border-current disabled:text-muted-foreground text-sm font-medium flex items-center outline-hidden select-none", className)}
	{...restProps}
/>
