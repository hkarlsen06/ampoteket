<script lang="ts">
	import type { CatalogProduct } from '#lib/catalog.js';
	import { formatMoney, unitLabel } from '#lib/format.js';
	import { getI18n } from '#lib/i18n/index.js';
	import BorrowOnlyBadge from '#lib/BorrowOnlyBadge.svelte';

	let { product, prominent = false, compact = false }: { product: CatalogProduct; prominent?: boolean; compact?: boolean } = $props();
	const i18n = getI18n();
</script>

{#if product.sale_unit_price_nok === null}
	<p class="m-0"><BorrowOnlyBadge {prominent} /></p>
{:else}
<p class="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
	<span class={['font-mono font-semibold', prominent ? 'text-2xl leading-tight' : compact ? 'text-base' : 'text-xl']}>{formatMoney(product.sale_unit_price_nok, i18n.locale)}</span>
	<span class="text-sm text-muted-foreground">{i18n.m.shop.perUnit(unitLabel(product.unit_symbol, i18n.locale, '1'))}</span>
</p>
{/if}
