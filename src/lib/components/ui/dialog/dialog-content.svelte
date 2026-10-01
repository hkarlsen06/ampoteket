<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import * as Dialog from "./index.js";
	import DialogPortal from "./dialog-portal.svelte";
	import type { Snippet } from "svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = false,
		closeLabel,
		variant = "center",
		preventScroll = false,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
		showCloseButton?: boolean;
		closeLabel?: string;
		/** `sheet`: a full-height panel from the right with bar header, scrolling body and footer rows. */
		variant?: "center" | "sheet";
	} = $props();

	const sheet = "top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 rounded-none p-0 data-open:zoom-in-100 md:max-w-3xl";
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		{preventScroll}
		class={cn(
			"bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 ring-foreground/10 grid min-w-0 max-h-[calc(100dvh-2rem)] max-w-[calc(100%_-_2rem)] gap-4 rounded-xl p-4 text-sm ring-1 duration-100 md:max-w-lg fixed top-1/2 left-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 wrap-anywhere outline-none",
			variant === "sheet" && sheet,
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton && closeLabel}
			<DialogPrimitive.Close data-slot="dialog-close">
				{#snippet child({ props })}
					<Button variant="ghost" class="absolute top-2 right-2" size="icon-sm" {...props}>
						<Icon icon={XIcon}  />
						<span class="sr-only">{closeLabel}</span>
					</Button>
				{/snippet}
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
