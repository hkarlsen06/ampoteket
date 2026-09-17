<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { AspectRatio } from '$lib/components/ui/aspect-ratio';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import Icon from '$lib/Icon.svelte';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import { codeText, itemTitle, nameWrap, sectionHeading } from '$lib/ui';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { productName, readCompleteCatalog, type CatalogConfig, type CatalogProduct } from '$lib/catalog';
	import { gridCell, gridRange } from '$lib/format';
	import { cabinetInner, locateProduct, raaco, readShelfTopology, type ShelfTopology } from '$lib/shelf-map';
	import LocationChips from '$lib/LocationChips.svelte';
	import ShelfDiagram from '$lib/ShelfDiagram.svelte';
	import ShelfZoom from '$lib/ShelfZoom.svelte';
	// One stage shows the wall or, zoomed in, one cabinet's drawers; contents grow
	// below it. `stacked` expands the diagrams instead of bounding them.
	let { config, product, title, labelledby, onreveal, headingLevel = 2, initialTopology = null, stacked = false }: {
		config: CatalogConfig | null; product?: CatalogProduct; title?: string; labelledby?: string; headingLevel?: 2 | 3; initialTopology?: ShelfTopology | null; stacked?: boolean;
		onreveal?: (section: HTMLElement) => void;
	} = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.shelfMap);
	const uid = $props.id();
	const initial = untrack(() => initialTopology);
	const initialLocation = untrack(() => initial && product ? locateProduct(initial, product) : null);
	let topology = $state<ShelfTopology | null>(initial);
	let mapState = $state<'loading' | 'ready' | 'error'>(initial ? 'ready' : 'loading');
	let refreshing = $state(false);
	let catalogState = $state<'idle' | 'loading' | 'ready' | 'error'>(initialLocation?.bin.has_products ? 'loading' : 'idle');
	let products = $state<CatalogProduct[]>([]);
	let cabinetId = $state<string | null>(initialLocation?.cabinet.id ?? null), binId = $state<string | null>(initialLocation?.bin.id ?? null);
	let showContents = $state(Boolean(initialLocation)), generation = 0;
	let stageSection = $state<HTMLElement>(), contentsSection = $state<HTMLElement>();
	let pendingReveal = $state<'drawers' | 'contents' | null>(null);
	let controller: AbortController | undefined, catalogController: AbortController | undefined;
	// Parts stored outside the drawer wall keep the browsable map without a highlight.
	const placed = $derived(product?.bin_code === null ? null : product);
	const location = $derived(topology && placed ? locateProduct(topology, placed) : null);
	const cabinets = $derived([...(topology?.cabinets ?? [])].sort((a, b) => b.outer_row - a.outer_row || a.outer_col - b.outer_col));
	const cabinetEntry = $derived(topology?.cabinets.find((entry) => entry.id === cabinetId));
	const bins = $derived([...(topology?.bins.filter((entry) => entry.cabinet_id === cabinetId) ?? [])]
		.sort((a, b) => b.inner_row - a.inner_row || a.inner_col - b.inner_col));
	const bin = $derived(bins.find((entry) => entry.id === binId));
	const assigned = $derived(bin ? products.filter((entry) => entry.bin_code === bin.code) : []);
	// Placeholders reserve the installed wall, two rows of six cabinets (docs/datamodell.md).
	const installedWall = 6 * raaco.width / (2 * raaco.height);
	const wallRows = $derived(cabinets.reduce((maximum, entry) => Math.max(maximum, entry.outer_row), 1));
	const partRow = 'flex min-h-16 w-full items-center justify-between gap-3 bg-card text-left';
	const wallCols = $derived(cabinets.reduce((maximum, entry) => Math.max(maximum, entry.outer_col), 1));

	// Only a selection requests advancement. Closing the sheet cancels the request;
	// routine refreshes preserve the visitor's reading position.
	$effect(() => {
		if (!pendingReveal) return;
		if (!onreveal) { pendingReveal = null; return; }
		if (pendingReveal === 'contents' && catalogState === 'loading') return;
		const section = pendingReveal === 'drawers' ? stageSection : contentsSection;
		if (section) {
			pendingReveal = null;
			untrack(() => onreveal?.(section));
		}
	});

	function cancelReads() { generation++; controller?.abort(); catalogController?.abort(); }
	onMount(() => { if (!initial) void load(); else if (initialLocation?.bin.has_products) void loadProducts(); });
	onDestroy(cancelReads);
	function refreshWhenVisible() {
		if (document.visibilityState === 'visible') void load();
	}
	async function loadProducts() {
		if (!config || !binId) return;
		const selectedBin = binId;
		const request = generation;
		catalogController?.abort();
		const own = new AbortController(); catalogController = own;
		const timeout = setTimeout(() => own.abort(), 30_000);
		catalogState = 'loading';
		try {
			const result = await readCompleteCatalog(config, { binId: selectedBin, signal: own.signal });
			if (request !== generation || catalogController !== own || selectedBin !== binId) return;
			products = result; catalogState = 'ready';
		} catch { if (request === generation && catalogController === own && selectedBin === binId) catalogState = 'error'; }
		finally { clearTimeout(timeout); }
	}
	async function load() {
		if (refreshing) return;
		cancelReads(); const request = generation;
		if (!topology) mapState = 'loading';
		if (catalogState === 'loading') catalogState = products.length ? 'ready' : 'idle';
		if (!config) { mapState = 'error'; return; }
		refreshing = true;
		const own = new AbortController(); controller = own;
		const timeout = setTimeout(() => own.abort(), 15_000);
		try {
			const result = await readShelfTopology(config, { signal: own.signal });
			if (request !== generation) return;
			const found = product ? locateProduct(result, product) : null;
			// Keep the visitor's selection by identity, including drawers moved to
			// another cabinet. Only fall back when the selected storage is gone.
			const selected = result.bins.find((entry) => entry.id === binId);
			if (selected) cabinetId = selected.cabinet_id;
			else if (!topology) {
				cabinetId = found?.cabinet.id ?? null; binId = found?.bin.id ?? null;
				showContents = Boolean(found && product);
			} else {
				// A vanished cabinet falls back to the wall; the visitor's level is kept otherwise.
				if (!result.cabinets.some((entry) => entry.id === cabinetId)) cabinetId = null;
				binId = null; showContents = false;
			}
			topology = result;
			mapState = 'ready';
			if (showContents && result.bins.find((entry) => entry.id === binId)?.has_products) void loadProducts();
			else { products = []; catalogState = 'idle'; }
		} catch { if (request === generation) mapState = 'error'; }
		finally { clearTimeout(timeout); if (request === generation) refreshing = false; }
	}
	function openLevel(id: string | null) {
		catalogController?.abort(); cabinetId = id; binId = null; showContents = false;
		products = []; catalogState = 'idle';
		if (id && onreveal) pendingReveal = 'drawers';
		// Back in the product's cabinet, its outlined drawer shows its parts again, as on arrival.
		if (id && id === location?.cabinet.id) {
			binId = location.bin.id; showContents = true;
			if (location.bin.has_products) void loadProducts();
		}
	}
	function selectBin(id: string) {
		if (id !== binId) { catalogController?.abort(); products = []; catalogState = 'idle'; }
		binId = id; showContents = true;
		pendingReveal = 'contents';
		const selected = bins.find((entry) => entry.id === id);
		if (selected?.has_products && (catalogState === 'idle' || catalogState === 'error')) void loadProducts();
	}
</script>

<svelte:window onfocus={refreshWhenVisible} ononline={refreshWhenVisible} />
<svelte:document onvisibilitychange={refreshWhenVisible} />

<section class="shelf-map min-w-0 wrap-break-word" aria-labelledby={labelledby ?? `${uid}-title`}>
	{#if !labelledby}<svelte:element this={`h${headingLevel}`} class={[sectionHeading, "mb-2"]} id={`${uid}-title`}>{title ?? m.title}</svelte:element>{/if}
	{#if product?.bin_code === null}<LocationChips plain note={product.location_note ?? i18n.m.shop.askStaff} />
	{:else if product}<LocationChips plain outerRow={location?.cabinet.outer_row ?? product.outer_row} outerCol={location?.cabinet.outer_col ?? product.outer_col}
		innerRow={location?.bin.inner_row ?? product.inner_row} innerCol={location?.bin.inner_col ?? product.inner_col}
		rowSpan={location?.bin.row_span ?? product.row_span} colSpan={location?.bin.col_span ?? product.col_span} />{/if}
	<noscript><p class="text-sm text-muted-foreground">{m.noJavascript}</p></noscript>
	<div class="map-status text-sm" role="status">
		{#if mapState === 'error'}<Alert.Message appearance="inline" role={undefined} variant="destructive" class="my-3">{topology ? m.previousRead : m.unavailable}</Alert.Message>
		{:else if mapState === 'ready' && placed && !location}<Alert.Message appearance="inline" role={undefined} class="my-3">{m.locationUnavailable}</Alert.Message>
		{:else if location?.moved}<Alert.Message appearance="inline" role={undefined} class="my-3">{m.moved}</Alert.Message>
		{:else if mapState === 'loading'}<span class="sr-only">{m.loading}</span>{/if}
	</div>
	{#if mapState === 'error'}
		<Button variant="outline" type="button" disabled={refreshing} onclick={load}>{m.retry}</Button>
	{/if}
	{#if mapState === 'ready' && placed && !location}
		<Button variant="link" class="refresh-product justify-start" href={i18n.href(`/p/${placed.code}`)} data-sveltekit-reload>{m.refreshProduct}</Button>
	{/if}
	<p class="sr-only">{m.keyboardHint}</p>
	<div class="levels mt-4 grid max-w-sm items-start gap-5">
		<ShelfZoom bind:element={stageSection} class="stage" open={cabinetEntry ? cabinetId : null} headingLevel={(headingLevel + 1) as 3 | 4} onchange={openLevel}
			title={cabinetEntry ? m.cabinet(gridCell(cabinetEntry.outer_row, cabinetEntry.outer_col)) : mapState === 'loading' && placed ? m.cabinet(gridCell(placed.outer_row, placed.outer_col)) : m.wall}>
			{#snippet cabinet()}{#if cabinetEntry}
				<div class="max-w-xs">
					<ShelfDiagram responsive expand={stacked} cabinet rows={cabinetEntry.inner_rows} cols={cabinetEntry.inner_cols} selected={binId} current={location?.bin.id}
						label={m.cabinet(gridCell(cabinetEntry.outer_row, cabinetEntry.outer_col))} emptyLabel={m.emptyDrawer} onselect={selectBin}
						items={bins.map((entry) => ({ id: entry.id, row: entry.inner_row, col: entry.inner_col,
							rowSpan: entry.row_span, colSpan: entry.col_span, empty: !entry.has_products, label: gridRange(entry.inner_row, entry.inner_col, entry.row_span, entry.col_span) }))} />
				</div>
			{/if}{/snippet}
			{#snippet wall(zoomTo)}
				{#if topology && cabinets.length}
					<ShelfDiagram responsive expand={stacked} rows={wallRows} cols={wallCols} selected={null} current={location?.cabinet.id}
						label={m.wall} onselect={zoomTo} items={cabinets.map((entry) => ({ id: entry.id,
							row: entry.outer_row, col: entry.outer_col, label: gridCell(entry.outer_row, entry.outer_col), inner: cabinetInner(entry, topology?.bins ?? []) }))} />
				{:else if mapState === 'loading' && placed}<div class="max-w-xs" style:max-width={stacked ? undefined : `min(20rem, (min(32rem, 70dvh) - 0.5rem) * ${raaco.width / raaco.height} + 0.5rem)`}><AspectRatio ratio={raaco.width / raaco.height}><Skeleton class="cabinet-placeholder h-full w-full rounded-none" /></AspectRatio></div>
				{:else}<AspectRatio ratio={installedWall}>
						{#if mapState === 'ready'}<Empty.Root class="wall-placeholder h-full rounded-none bg-muted p-2"><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
						{:else}<Skeleton class="wall-placeholder h-full rounded-none" />{/if}
					</AspectRatio>{/if}
			{/snippet}
		</ShelfZoom>
		{#if showContents && bin}
			<section bind:this={contentsSection} class="drawer-contents min-w-0" aria-labelledby={`${uid}-contents`}>
				<svelte:element this={`h${headingLevel + 1}`} class={[itemTitle, "mb-2"]} id={`${uid}-contents`} tabindex={onreveal ? -1 : undefined}>{m.contents(gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span))}</svelte:element>
				<div class="contents-status my-2 text-sm" role="status">
					{#if !bin.has_products}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>
					{:else if catalogState === 'loading' && !assigned.length}<div class="grid min-h-11 items-center"><span class="sr-only">{m.productsLoading}</span><Skeleton class="h-5 w-full" aria-hidden="true" /></div>
					{:else if catalogState === 'error'}<Alert.Message appearance="inline" role={undefined} variant="destructive">{m.productsUnavailable}</Alert.Message>
					{:else if catalogState === 'ready' && !assigned.length}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>{/if}
				</div>
				{#if bin.has_products && catalogState === 'error'}<Button variant="outline" type="button" onclick={() => bin && selectBin(bin.id)}>{m.retryProducts}</Button>{/if}
				{#if bin.has_products && assigned.length}
					<ul class="product-list m-0 grid list-none gap-2 p-0">
						{#each assigned as entry (entry.product_id)}
							<li>
								<!-- One row family; the current part is marked like the diagram's current drawer. -->
								{#snippet identity()}<span class="grid min-w-0 gap-1"><span class={[itemTitle, nameWrap]}>{productName(entry, i18n.locale)}</span><span class={[codeText, 'text-muted-foreground']}>{entry.code}</span></span>{/snippet}
								{#if entry.product_id === product?.product_id}
									<div class={[partRow, 'border-3 border-warning p-2.5 ring-2 ring-[var(--focus-contrast)]']} aria-current="page">{@render identity()}</div>
								{:else}
									<a class={[partRow, 'border border-input p-3 text-foreground no-underline hover:bg-muted']} href={i18n.href(`/p/${entry.code}`)}>
										{@render identity()}<Icon icon={CaretRightIcon} class="size-5" />
									</a>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>
</section>
