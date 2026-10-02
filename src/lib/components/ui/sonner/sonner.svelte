<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import Icon from "#lib/Icon.svelte";
	import SpinnerGapIcon from 'phosphor-svelte/lib/SpinnerGapIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

	let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme="system"
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
	toastOptions={{
		classes: {
			toast: "cn-toast !pr-14",
			closeButton: "!left-auto !right-1 !top-1/2 !size-11 ![transform:translateY(-50%)] !border-0 !rounded-md !bg-transparent !text-muted-foreground hover:!text-foreground",
		},
	}}
	{...restProps}
>
	{#snippet loadingIcon()}
		<Icon icon={SpinnerGapIcon} class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<Icon icon={CheckCircleIcon} class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<Icon icon={XCircleIcon} class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<Icon icon={InfoIcon} class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<Icon icon={WarningIcon} class="size-4" />
	{/snippet}
</Sonner>
