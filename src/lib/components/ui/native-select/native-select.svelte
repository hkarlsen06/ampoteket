<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import { controlStyles } from "#lib/components/ui/control.js";
	import { cn } from "#lib/utils.js";
	import type { HTMLSelectAttributes } from "svelte/elements";

	type NativeSelectProps = Omit<HTMLSelectAttributes, "size"> & {
		size?: "sm" | "default";
		ref?: HTMLSelectElement | null;
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = "default",
		children,
		...restProps
	}: NativeSelectProps = $props();
</script>

<div
	class={cn(
		"group/native-select relative min-w-0 w-full ",
		className
	)}
	data-slot="native-select-wrapper"
	data-size={size}
>
	<select
		bind:value
		bind:this={ref}
		data-slot="native-select"
		data-size={size}
		class={cn(controlStyles, "h-12 appearance-none py-2 pr-9 pl-3 select-none data-[size=sm]:h-11 disabled:pointer-events-none")}
		{...restProps}
	>
		{@render children?.()}
	</select>
	<Icon icon={CaretDownIcon} class="text-muted-foreground top-1/2 right-2.5 size-4 -translate-y-1/2 pointer-events-none absolute select-none" aria-hidden data-slot="native-select-icon" />
</div>
