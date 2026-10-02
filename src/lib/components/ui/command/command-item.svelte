<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandPrimitive.ItemProps = $props();
</script>

<CommandPrimitive.Item
	bind:ref
	data-slot="command-item"
	class={cn(
		"data-selected:bg-muted data-selected:text-foreground data-selected:*:[svg]:text-foreground relative flex cursor-default items-center gap-2 min-h-11 rounded-sm border border-transparent px-2 py-1.5 text-base outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! [&_svg:not([class*='size-'])]:size-4 group/command-item data-[disabled=true]:pointer-events-none data-[disabled=true]:border-dashed data-[disabled=true]:border-muted-foreground data-[disabled=true]:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<CheckIcon class="ml-auto invisible group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:visible" aria-hidden="true" />
</CommandPrimitive.Item>
