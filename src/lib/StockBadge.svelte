<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
	import { Badge } from '$lib/components/ui/badge';
	import { getI18n } from '$lib/i18n';
	import { compareDecimals } from '$lib/decimal';
	import { formatDecimal, unitLabel } from '$lib/format';

	// State indicator: status icon + word, never colour alone.
	// «Ukjent»/Unavailable is a fetch state, never rendered as 0.
	// Staff views pass the product's minimum; in stock below it shows «Lite igjen».
	let {
		quantity,
		unit,
		minimum = '0',
		showQuantity = true,
		compact = false
	}: {
		quantity: string | null;
		unit: string;
		minimum?: string;
		showQuantity?: boolean;
		compact?: boolean;
	} = $props();
	const i18n = getI18n();
	const state = $derived(quantity === null ? null : compareDecimals(quantity, '0'));
	const low = $derived(state === 1 && compareDecimals(quantity!, minimum) < 0);
	const label = $derived(
		state === null
			? i18n.m.shop.unavailable
			: low
				? i18n.m.shop.stockLow
				: state > 0
					? i18n.m.shop.stockPositive
					: state < 0
						? i18n.m.shop.stockNegative
						: i18n.m.shop.stockZero
	);
</script>

<span class={['stock inline-flex min-w-0 items-center wrap-anywhere', compact ? 'flex-nowrap gap-1.5' : 'flex-wrap gap-x-3 gap-y-1.5']}>
	<Badge variant="outline" class={[
		'gap-1.5 whitespace-normal',
		state === null ? 'text-muted-foreground' : low ? 'border-transparent bg-warning text-on-warning' : state > 0 ? 'border-success text-success' : 'border-destructive text-destructive',
		// Low stock keeps its filled yellow chip and visible word: yellow fails contrast as bare text.
		compact && !low && 'rounded-none border-0 bg-transparent p-0'
	]}>
		{#if state === null}<Icon icon={QuestionIcon} class="size-3.5 shrink-0" aria-hidden="true" />
		{:else if low}<Icon icon={WarningIcon} class="size-3.5 shrink-0" aria-hidden="true" />
		{:else if state > 0}<Icon icon={CheckCircleIcon} class="size-3.5 shrink-0" aria-hidden="true" />
		{:else}<Icon icon={XCircleIcon} class="size-3.5 shrink-0" aria-hidden="true" />{/if}
		<span class={compact && !low && showQuantity && quantity !== null ? 'sr-only' : undefined}>{label}</span>
	</Badge>
	{#if showQuantity && quantity !== null}
		<span class="font-mono text-sm font-semibold tabular-nums">{i18n.m.shop.quantity(formatDecimal(quantity, i18n.locale), unitLabel(unit, i18n.locale, quantity))}</span>
	{/if}
</span>
