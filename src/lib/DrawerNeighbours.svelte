<script lang="ts">
	// What the chosen drawer and the drawers sharing an edge with it already hold, so a
	// value in the wrong drawer or cabinet stands out against its series while placing a
	// product (page-admin-stock.md#products). Drawers are often shared; nothing warns.
	// The product list is a live subscription, so picking another drawer never waits
	// for a request. Only a chosen drawer is announced.
	import { untrack } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import { api } from '#lib/convex.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { productName } from '#lib/catalog.js';
	import { gridRange } from '#lib/format.js';
	import { nameWrap } from '#lib/ui.js';
	import { binProducts, drawerNeighbours, type DrawerSide, type ShelfTopology } from '#lib/shelf-map.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import Icon from '#lib/Icon.svelte';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';

	let { topology, selected, exclude = null, class: className }: {
		topology: ShelfTopology; selected: string | null; exclude?: string | null; class?: string;
	} = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	const arrows = { above: ArrowUpIcon, left: ArrowLeftIcon, right: ArrowRightIcon, below: ArrowDownIcon };
	const query = useQuery(api.products.list, () => admin.status === 'ready' ? {} : 'skip');
	const products = $derived(query.data ?? null);
	$effect(() => { if (query.error) void admin.permissionFailure(query.error); });

	type Row = { side: DrawerSide | 'here'; id: string; label: string; names: string[] };
	// Spatial reading order: above, left, the drawer itself, right, below.
	const rows = $derived.by((): Row[] | null => {
		const list = products, bin = topology.bins.find((item) => item.id === selected);
		const sides = bin && drawerNeighbours(topology.bins, bin.id);
		if (!list || !bin || !sides) return null;
		const row = (side: Row['side'], drawer: typeof bin): Row => ({ side, id: drawer.id,
			label: gridRange(drawer.inner_row, drawer.inner_col, drawer.row_span, drawer.col_span),
			names: binProducts(list, drawer.id).filter((product) => product.id !== exclude).map((product) => productName(product, i18n.locale)) });
		return [...sides.above.map((drawer) => row('above', drawer)), ...sides.left.map((drawer) => row('left', drawer)), row('here', bin),
			...sides.right.map((drawer) => row('right', drawer)), ...sides.below.map((drawer) => row('below', drawer))];
	});
	// The drawer already saved is not news when the editor opens; a newly chosen one is.
	const initial = untrack(() => selected); let chosen = $state(false);
	$effect(() => { if (selected !== initial) chosen = true; });
	const here = $derived(rows?.find((row) => row.side === 'here'));
	const summary = $derived(!chosen || !here ? '' : here.names.length
		? m.drawerHolds(new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(here.names)) : m.drawerHoldsNothing);
</script>

<p class="sr-only" aria-live="polite">{summary}</p>
{#if selected && query.error}
	<Alert.Message appearance="inline" variant="destructive" role="alert" class={className}>{m.drawerContentsUnavailable}</Alert.Message>
{:else if rows}
	<div class={className} role="group" aria-label={m.drawerContents}>
		<dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
			{#each rows as row (row.id)}
				<dt class={['flex min-h-5 items-center gap-1.5 font-mono', row.side === 'here' && 'font-semibold']}>
					{#if row.side === 'here'}<span class="size-4" aria-hidden="true"></span>{:else}<Icon icon={arrows[row.side]} size={16} />{/if}
					<span class="sr-only">{m.drawerSides[row.side]}</span>{row.label}
				</dt>
				<dd class="m-0 min-w-0">
					{#if row.names.length}<ul class="m-0 list-none p-0">{#each row.names as name, index (index)}<li class={nameWrap}>{name}</li>{/each}</ul>
					{:else}<span class="text-muted-foreground">{row.side === 'here' ? m.noOtherProducts : m.drawerEmpty}</span>{/if}
				</dd>
			{/each}
		</dl>
	</div>
{/if}
