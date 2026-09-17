<script lang="ts">
	import { gridCell, gridRange, unitLabel } from '$lib/format';
	import { getI18n } from '$lib/i18n';
	import type { CatalogProduct } from '$lib/catalog';
	import StockBadge from '$lib/StockBadge.svelte';
	import LocationChips from '$lib/LocationChips.svelte';
	import * as Popover from '$lib/components/ui/popover';

	let { product, showLocation = true, plain = false, inline = false }: {
		product: CatalogProduct;
		showLocation?: boolean;
		plain?: boolean;
		/** One text line, «92 stk i B2 • C4», for tight clusters such as the scanner.
		 * Tapping the coordinates shows them as labelled cabinet and drawer chips. */
		inline?: boolean;
	} = $props();
	const i18n = getI18n();
	const location = $derived(product.bin_code === null ? { note: product.location_note ?? i18n.m.shop.askStaff }
		: { outerRow: product.outer_row, outerCol: product.outer_col, innerRow: product.inner_row, innerCol: product.inner_col, rowSpan: product.row_span, colSpan: product.col_span });
</script>

{#if inline}
<div class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
	<StockBadge quantity={product.quantity} unit={unitLabel(product.unit_symbol, i18n.locale)} compact />
	{#if location.outerRow === undefined}
		<span class="min-w-0 wrap-anywhere text-muted-foreground"><span class="sr-only">{`${i18n.m.shop.location}: `}</span>{location.note}</span>
	{:else}
	<span class="text-muted-foreground">{i18n.m.shop.at}</span>
	<Popover.Root>
		<Popover.Trigger class="min-h-6 cursor-pointer font-mono font-semibold underline decoration-muted-foreground decoration-dotted underline-offset-4">
			<span class="sr-only">{`${i18n.m.shop.cabinet} `}</span>{gridCell(location.outerRow, location.outerCol)}<span class="font-normal text-muted-foreground" aria-hidden="true">&nbsp;•&nbsp;</span><span class="sr-only">{`, ${i18n.m.shop.drawer} `}</span>{gridRange(location.innerRow, location.innerCol, location.rowSpan, location.colSpan)}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-auto max-w-[calc(100vw-2rem)]">
			<LocationChips {...location} />
		</Popover.Content>
	</Popover.Root>
	{/if}
</div>
{:else}
<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
	<StockBadge quantity={product.quantity} unit={unitLabel(product.unit_symbol, i18n.locale)} compact />
	{#if showLocation}
		<LocationChips {...location} {plain} />
	{/if}
</div>
{/if}
