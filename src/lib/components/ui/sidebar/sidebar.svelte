<script lang="ts">
	import * as Dialog from "#lib/components/ui/dialog/index.js";
	import { Separator } from "#lib/components/ui/separator/index.js";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import { SIDEBAR_WIDTH_MOBILE } from "./constants.js";
	import { useSidebar } from "./context.svelte.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		side = "left",
		variant = "sidebar",
		collapsible = "offcanvas",
		class: className,
		label,
		closeLabel,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		label: string;
		closeLabel: string;
		side?: "left" | "right";
		variant?: "sidebar" | "floating" | "inset";
		collapsible?: "offcanvas" | "icon" | "none";
	} = $props();

	const sidebar = useSidebar();
	let restoreFocus = false;
	$effect(() => { if (sidebar.openMobile) restoreFocus = false; });
</script>

{#if collapsible === "none"}
	<div
		class={cn(
			"flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
			className
		)}
		bind:this={ref}
		{...restProps}
	>
		{@render children?.()}
	</div>
{:else if sidebar.isMobile}
	<Dialog.Root bind:open={() => sidebar.openMobile, (v) => { restoreFocus = !v; sidebar.setOpenMobile(v); }}>
		<Dialog.Content
			bind:ref
			id={sidebar.id}
			data-sidebar="sidebar"
			data-slot="sidebar"
			data-mobile="true"
			class="inset-y-0 left-0 flex h-dvh max-h-dvh w-(--sidebar-width) max-w-[calc(100%-3rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-sidebar p-0 text-sidebar-foreground data-open:zoom-in-100 data-closed:zoom-out-100"
			style="--sidebar-width: {SIDEBAR_WIDTH_MOBILE};"
			preventScroll={false}
			aria-describedby={undefined}
			showCloseButton
			{closeLabel}
			onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreFocus) sidebar.trigger?.focus(); }}
		>
			<Dialog.Title class="sr-only">{label}</Dialog.Title>
			<Separator orientation="vertical" class="pointer-events-none absolute inset-y-0 right-0" />
			<div class="flex min-h-0 flex-1 flex-col" {...restProps}>
				{@render children?.()}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<div
		bind:this={ref}
		class="group peer hidden shrink-0 self-stretch text-sidebar-foreground md:block"
		data-state={sidebar.state}
		data-collapsible={sidebar.state === "collapsed" ? collapsible : ""}
		data-variant={variant}
		data-side={side}
		data-slot="sidebar"
	>
		<!-- Sticky within the admin shell, below the site header. -->
		<div
			data-slot="sidebar-container"
			data-side={side}
			class={cn(
				"sticky top-(--header-h) z-10 hidden h-[calc(100dvh-var(--header-h))] w-(--sidebar-width) transition-[width] duration-150 ease-out group-data-[collapsible=offcanvas]:w-0 group-data-[collapsible=offcanvas]:invisible md:flex",
				// Adjust the padding for floating and inset variants.
				variant === "floating" || variant === "inset"
					? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_(--spacing(4))_+_2px)]"
					: "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
				className
			)}
			{...restProps}
		>
			{#if variant === "sidebar"}
				<Separator orientation="vertical" class={cn("pointer-events-none absolute inset-y-0", side === "left" ? "end-0" : "start-0")} />
			{/if}
			<div
				data-sidebar="sidebar"
				data-slot="sidebar-inner"
				id={sidebar.id}
				class={cn(
					"bg-sidebar group-data-[variant=floating]:ring-sidebar-border group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 flex size-full flex-col",
					// Keep content clear of the 1px separator so the icon rail centres evenly.
					variant === "sidebar" && (side === "left" ? "pe-px" : "ps-px")
				)}
			>
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}
