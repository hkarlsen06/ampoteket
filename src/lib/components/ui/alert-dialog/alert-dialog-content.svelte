<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
	import { cn, type WithoutChild, type WithoutChildrenOrChild } from "#lib/utils.js";
	import AlertDialogOverlay from "./alert-dialog-overlay.svelte";
	import AlertDialogPortal from "./alert-dialog-portal.svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		size = "default",
		portalProps,
		preventScroll = false,
		onOpenAutoFocus,
		...restProps
	}: WithoutChild<AlertDialogPrimitive.ContentProps> & {
		size?: "default" | "sm";
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof AlertDialogPortal>>;
	} = $props();
</script>

<AlertDialogPortal {...portalProps}>
	<AlertDialogOverlay />
	<AlertDialogPrimitive.Content
		bind:ref
		data-slot="alert-dialog-content"
		data-size={size}
		{preventScroll}
		onOpenAutoFocus={(event) => {
			onOpenAutoFocus?.(event);
			if (event.defaultPrevented) return;
			event.preventDefault();
			const cancel = ref?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]:not(:disabled)');
			(cancel ?? ref)?.focus({ preventScroll: true });
		}}
		class={cn(
			"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-popover text-popover-foreground ring-foreground/10 gap-4 rounded-xl p-4 ring-1 duration-100 max-w-xs data-[size=default]:md:max-w-sm group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)_auto] w-[calc(100%_-_2rem)] -translate-x-1/2 -translate-y-1/2 wrap-anywhere outline-none",
			className
		)}
		{...restProps}
	/>
</AlertDialogPortal>
