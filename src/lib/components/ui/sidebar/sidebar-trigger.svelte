<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimpleIcon';
	import { Button } from "#lib/components/ui/button/index.js";
	import { cn } from "#lib/utils.js";
	import { useSidebar } from "./context.svelte.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		onclick,
		label,
		...restProps
	}: ComponentProps<typeof Button> & {
		onclick?: (e: MouseEvent) => void;
		label: string;
	} = $props();

	const sidebar = useSidebar();
	$effect(() => { sidebar.trigger = ref as HTMLButtonElement | null; });
</script>

<Button
	bind:ref
	data-sidebar="trigger"
	data-slot="sidebar-trigger"
	variant="ghost"
	size="icon-sm"
	// aria-expanded is for assistive tech; an open sidebar is not a pressed state.
	class={cn("aria-expanded:not-hover:bg-transparent", className)}
	type="button"
	aria-label={label}
	aria-expanded={sidebar.isMobile ? sidebar.openMobile : sidebar.open}
	aria-controls={sidebar.id}
	onclick={(e) => {
		onclick?.(e);
		sidebar.toggle();
	}}
	{...restProps}
>
	<Icon icon={SidebarSimpleIcon} class="size-5" />
</Button>
