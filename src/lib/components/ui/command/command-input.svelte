<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		value = $bindable(""),
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<div data-slot="command-input-wrapper" class="shrink-0 p-1 pb-0">
	<InputGroup.Root class="*:data-[slot=input-group-addon]:pl-2!">
		<CommandPrimitive.Input
			{value}
			class={cn(
				"w-full text-base outline-hidden disabled:cursor-not-allowed",
				className
			)}
			{...restProps}
		>
			{#snippet child({ props })}
				<InputGroup.Input inputmode="search" enterkeyhint="search" {...props} bind:value bind:ref />
			{/snippet}
		</CommandPrimitive.Input>
		<InputGroup.Addon>
			<MagnifyingGlassIcon class="size-4 shrink-0 text-muted-foreground" />
		</InputGroup.Addon>
	</InputGroup.Root>
</div>
