<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import StateBadge from '#lib/StateBadge.svelte';
	import { cardLink, codeText, nameWrap } from '#lib/ui.js';
	import { productName } from '#lib/catalog.js';
	import { categoryBesideName, getI18n } from '#lib/i18n/index.js';
	import { formatMoney, unitLabel } from '#lib/format.js';
	import CategoryGraphic from '#lib/CategoryGraphic.svelte';
	import StockBadge from '#lib/StockBadge.svelte';
	import LocationChips from '#lib/LocationChips.svelte';
	import BorrowOnlyBadge from '#lib/BorrowOnlyBadge.svelte';
	import type { AdminProduct, ProductReferences } from '#lib/admin-products.js';

	// The public catalog card (page-catalog.md) for staff lists, linking to the editor.
	// Renders one <li>; the parent <ul> owns the grid columns.
	let { product, references, quantity, headingLevel = 2 }: {
		product: AdminProduct; references: ProductReferences | null; quantity: string | null; headingLevel?: 2 | 3;
	} = $props();
	const i18n = getI18n();
	const bin = $derived(references?.shelf.bins.find(b => b.id === product.bin_id));
	const cabinet = $derived(references?.shelf.cabinets.find(c => c.id === bin?.cabinet_id));
	const category = $derived(references?.categories.find(c => c.id === product.category_id)?.name ?? null);
	const unit = $derived(unitLabel(product.unit_code, i18n.locale));
	const categoryBeside = $derived(categoryBesideName(category, productName(product, i18n.locale), i18n.locale));
</script>

<li class="row-span-2 grid min-w-0 grid-rows-subgrid">
	<Card.Root class={cardLink}>
		<Card.Header class="grid grid-cols-[minmax(0,1fr)_5rem] content-start items-start gap-3 p-0">
			<div class="min-w-0">
				<svelte:element this={`h${headingLevel}`} class={['m-0 text-lg leading-snug font-semibold', nameWrap]}><a class="text-foreground no-underline hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!" href={i18n.href(`/admin/products/${product.id}`)}>{productName(product, i18n.locale)}</a></svelte:element>
				<div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
					<span class={codeText}>{product.code}</span>
					{#if categoryBeside}<span>{categoryBeside}</span>{/if}
				</div>
			</div>
			<div class="h-16"><CategoryGraphic {category} /></div>
		</Card.Header>
		<Card.Content class="grid content-start gap-2 p-0">
			<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				{#if product.sale_unit_price_nok === null}<p class="m-0"><BorrowOnlyBadge /></p>
				{:else}
				<p class="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
					<span class="font-mono text-xl font-semibold">{formatMoney(product.sale_unit_price_nok, i18n.locale)}</span>
					<span class="text-sm text-muted-foreground">{i18n.m.shop.perUnit(unitLabel(product.unit_code, i18n.locale, '1'))}</span>
				</p>
				{/if}
				{#if !product.is_active}<StateBadge tone="neutral">{i18n.m.adminProducts.inactive}</StateBadge>{/if}
			</div>
			<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
				<StockBadge {quantity} {unit} minimum={product.minimum_stock} compact />
				{#if bin && cabinet}
					<LocationChips outerRow={cabinet.outer_row} outerCol={cabinet.outer_col} innerRow={bin.inner_row} innerCol={bin.inner_col} rowSpan={bin.row_span} colSpan={bin.col_span} plain />
				{:else if product.location_note}<LocationChips note={product.location_note} plain />
				{:else}<span class="text-sm text-muted-foreground">{i18n.m.adminProducts.unplaced}</span>{/if}
			</div>
		</Card.Content>
	</Card.Root>
</li>
