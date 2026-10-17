<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formActions, pageHeader, pageHeading, cardGrid, sheetBody, shelfPickerSheet } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { onMount } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import { api } from '#lib/convex.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Toggle } from '#lib/components/ui/toggle/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import Icon from '#lib/Icon.svelte';
	import SortAscendingIcon from 'phosphor-svelte/lib/SortAscendingIcon';
	import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import LabelShelfSelection from '#lib/LabelShelfSelection.svelte';
	import { matchesSearch, searchTerms } from '#lib/catalog-search.js';
	import { productName } from '#lib/catalog.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import AdminProductCard from '#lib/AdminProductCard.svelte';
	import AdminProductScanner from '#lib/AdminProductScanner.svelte';
	import { adminSearchTexts, compareAttention, inventoryStock, parseAdminProduct, productAttributes, productReferences, readProductCommand, stockRank, type AdminProduct, type ProductCommand } from '#lib/admin-products.js';
	import ProductReferencesEditor from '#lib/ProductReferences.svelte';
	import { readDraft, writeDraft } from '#lib/drafts.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	// Live subscriptions: products, stock and specifications stay current without re-reading.
	const live = () => admin.status === 'ready' ? {} : 'skip' as const;
	const productRows = useQuery(api.products.list, live); const referenceRows = useQuery(api.products.references, live);
	const shelfRows = useQuery(api.catalog.shelfMap, live); const attributeRows = useQuery(api.products.attributes, live);
	const inventoryRows = useQuery(api.stock.inventory, live);
	const catalog = $derived.by(() => {
		if (!productRows.data || !referenceRows.data || !shelfRows.data || !attributeRows.data) return null;
		try {
			const items = productRows.data.map(parseAdminProduct).sort((a, b) => a.code.localeCompare(b.code));
			const refs = productReferences(referenceRows.data, shelfRows.data);
			return { products: items, references: refs, searchTexts: adminSearchTexts(items, refs, productAttributes(attributeRows.data)) };
		} catch { return 'invalid' as const; }
	});
	const stock = $derived.by(() => {
		try { return inventoryRows.data ? new Map(inventoryStock(inventoryRows.data).map(s => [s.product_id, s])) : null; }
		catch { return 'invalid' as const; }
	});
	const products = $derived(catalog && catalog !== 'invalid' ? catalog.products : null);
	const references = $derived(catalog && catalog !== 'invalid' ? catalog.references : null);
	// A failed stock read shows as unavailable per card instead of hiding the product list.
	const failed = $derived(catalog === 'invalid' || Boolean(productRows.error || referenceRows.error || shelfRows.error || attributeRows.error));
	const stockFailed = $derived(stock === 'invalid' || Boolean(inventoryRows.error));
	const busy = $derived(products === null && !failed);
	$effect(() => { for (const result of [productRows, referenceRows, shelfRows, attributeRows, inventoryRows]) if (result.error) void admin.permissionFailure(result.error); });
	let query = $state(''); let lowStock = $state(false); let activity = $state('all'); let sort = $state<keyof typeof sorters>('attention'); let sortOpen = $state(false); let bins = $state<string[]>([]); let locationsOpen = $state(false); let pending = $state<ProductCommand | null>(null);
	// Products load in code order and sorting is stable, so code breaks every tie.
	const counted = (p: AdminProduct) => stock === 'invalid' ? undefined : stock?.get(p.id)?.last_counted_at;
	const quantity = (p: AdminProduct) => stock === 'invalid' ? undefined : stock?.get(p.id)?.quantity;
	const sorters = {
		attention: (a: AdminProduct, b: AdminProduct) => compareAttention(a, quantity(a), b, quantity(b)),
		// Never-counted products first; ISO timestamps compare as text.
		counted: (a: AdminProduct, b: AdminProduct) => (counted(a) ?? '').localeCompare(counted(b) ?? ''),
		code: () => 0,
		name: (a: AdminProduct, b: AdminProduct) => productName(a, i18n.locale).localeCompare(productName(b, i18n.locale), i18n.locale),
	};
	// Search, state and sort survive Back and reload in this tab. Admin pages mount
	// after Auth, too late for a SvelteKit snapshot to restore on reload.
	let viewLoaded = $state(false);
	let visibleCount = $state(50);
	$effect(() => {
		if (!viewLoaded) return;
		writeDraft(admin.userId, 'products-view', query || activity !== 'all' || lowStock || bins.length || sort !== 'attention' || visibleCount > 50 ? { query, activity, lowStock, bins, sort, visibleCount } : null, 'session');
	});
	// Low stock matches the overview's attention list: active and sold out or below minimum.
	const terms = $derived(searchTerms(query));
	// A drawer archived since the view was saved drops out instead of hiding every product.
	const liveBins = $derived(references ? bins.filter(id => references!.shelf.bins.some(bin => bin.id === id)) : bins);
	const filtered = $derived((products ?? []).filter(p => (activity === 'all' || p.is_active === (activity === 'active')) && (!lowStock || stockRank(p, quantity(p)) <= 1) && (!liveBins.length || liveBins.includes(p.bin_id ?? '')) && matchesSearch(catalog && catalog !== 'invalid' ? catalog.searchTexts.get(p.id) ?? '' : '', terms)).sort(sorters[sort]));
	onMount(() => {
		try { pending = readProductCommand(sessionStorage); } catch { /* The editor reports blocked persistence before any write. */ }
		const view = readDraft(admin.userId, 'products-view', 'session') as Record<string, unknown> | null;
		if (typeof view?.query === 'string' && ['all', 'active', 'inactive'].includes(view.activity as string) && typeof view.sort === 'string' && Object.hasOwn(sorters, view.sort)) {
			query = view.query; activity = view.activity as string; sort = view.sort as keyof typeof sorters; lowStock = view.lowStock === true;
			if (Array.isArray(view.bins) && view.bins.every(id => typeof id === 'string')) bins = view.bins;
			if (typeof view.visibleCount === 'number' && Number.isSafeInteger(view.visibleCount) && view.visibleCount >= 50) visibleCount = view.visibleCount;
		}
		// The overview links here for everything needing attention, not only its first eight.
		if (page.url.searchParams.get('stock') === 'low') { query = ''; activity = 'all'; lowStock = true; bins = []; sort = 'attention'; visibleCount = 50; }
		viewLoaded = true;
	});
	function openProduct(id: string) { void goto(i18n.href(`/admin/products/${id}`)); }
</script>
<svelte:head><title>{m.title}</title></svelte:head>
<div class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<div class={formActions}>
		<Button variant="default" href={i18n.href('/admin/products/new')}>{m.newProduct}</Button>
		<AdminProductScanner {products} disabled={failed || busy} onproduct={openProduct} />
	</div>
</div>
{#if pending}
	<div class="mb-6 grid justify-items-start gap-1">
		<Alert.Message appearance="inline">{m.pending}</Alert.Message>
		<Button variant="link" href={i18n.href(`/admin/products/${pending.payload.id}`)}>{m.resume}</Button>
	</div>
{/if}
<Field.Group layout="row" class="filters mb-6">
	<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.search}</Field.Label><Input id={`${fieldId}-1`} type="search" enterkeyhint="search" bind:value={() => query, value => { query = value; visibleCount = 50; }} /></Field.Field>
	<Dialog.Root bind:open={locationsOpen}>
		<Dialog.Trigger disabled={!references}>
			{#snippet child({ props })}<Button {...props} variant="outline" class="self-end" disabled={!references}><Icon icon={MapPinIcon} aria-hidden="true" />{liveBins.length ? i18n.m.catalog.locationSelected(liveBins.length) : i18n.m.catalog.location}</Button>{/snippet}
		</Dialog.Trigger>
		<!-- The catalog's shelf picker sheet: bottom sheet on phones, right-hand panel from 48rem. -->
		<Dialog.Content variant="sheet" preventScroll={false} showCloseButton={false} class={shelfPickerSheet} aria-describedby={undefined}>
			<Dialog.Header layout="bar">
				<Dialog.Title>{i18n.m.catalog.location}</Dialog.Title>
				<div class="flex shrink-0 items-center gap-1">
					{#if liveBins.length}<Button variant="ghost" size="sm" onclick={() => { bins = []; visibleCount = 50; locationsOpen = false; }}>{i18n.m.adminLabels.clearSelection}</Button>{/if}
					<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon" aria-label={i18n.m.catalog.closeLocations}><Icon icon={XIcon} class="size-5" aria-hidden="true" /></Button>{/snippet}</Dialog.Close>
				</div>
			</Dialog.Header>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (the named scroll region must be keyboard-scrollable) -->
			<div class={sheetBody} role="region" tabindex="0" aria-label={i18n.m.catalog.location}>
				{#if references}<LabelShelfSelection topology={references.shelf} heading={null} selected={liveBins} onpick={id => { bins = [id]; visibleCount = 50; locationsOpen = false; }} />{/if}
			</div>
		</Dialog.Content>
	</Dialog.Root>
	<Field.Set class="w-auto gap-2">
		<Field.Legend id="products-state-label" variant="label">{m.stateFilter}</Field.Legend>
		<ToggleGroup.Root type="single" variant="outline" value={activity} onValueChange={(value) => { if (value) { activity = value; visibleCount = 50; } }} aria-labelledby="products-state-label">
			<ToggleGroup.Item value="all">{m.all}</ToggleGroup.Item>
			<ToggleGroup.Item value="active">{m.active}</ToggleGroup.Item>
			<ToggleGroup.Item value="inactive">{m.inactive}</ToggleGroup.Item>
		</ToggleGroup.Root>
	</Field.Set>
	<Toggle variant="outline" class="self-end" pressed={lowStock} onPressedChange={(pressed) => { lowStock = pressed; visibleCount = 50; }}>{m.lowStock}</Toggle>
	<Popover.Root bind:open={sortOpen}>
		<Popover.Trigger>{#snippet child({ props })}<Button {...props} variant="outline" size="icon" class="ml-auto" aria-label={m.sortCurrent(m.sort[sort])}><Icon icon={SortAscendingIcon} class="size-5" /></Button>{/snippet}</Popover.Trigger>
		<Popover.Content align="end" class="w-auto max-w-[calc(100vw-2rem)]">
			<Field.Set class="gap-2">
				<Field.Legend id="products-sort-label" variant="label">{m.sortBy}</Field.Legend>
				<!-- Tapping (or Space on) an option chooses it and closes; arrow keys browse without closing. -->
				<RadioGroup.Root value={sort} onValueChange={(value) => { sort = value as keyof typeof sorters; visibleCount = 50; }} aria-labelledby="products-sort-label">
					{#each Object.keys(sorters) as key (key)}
						<Field.Field orientation="horizontal"><RadioGroup.Item id={`${fieldId}-sort-${key}`} value={key} onclick={() => { sortOpen = false; }} /><Field.Label for={`${fieldId}-sort-${key}`} class="font-normal">{m.sort[key as keyof typeof sorters]}</Field.Label></Field.Field>
					{/each}
				</RadioGroup.Root>
			</Field.Set>
		</Popover.Content>
	</Popover.Root>
</Field.Group>
{#if failed || stockFailed}<Alert.Message appearance="inline" variant="destructive" role="alert">{failed ? m.unavailable : m.inventoryUnavailable}</Alert.Message>{/if}
{#if products === null && busy}
	<span class="sr-only" role="status">{m.loading}</span>
	<div class={[cardGrid, 'min-h-80 content-start']} aria-busy={busy}>
		{#each [1, 2, 3] as row (row)}<Skeleton class="h-40 rounded-xl" aria-hidden="true" />{/each}
	</div>
{/if}
{#if products !== null}
	{#if !products.length}
		<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>
	{:else if !filtered.length}
		<Empty.Root><Empty.Description>{m.empty}</Empty.Description><Empty.Content><Button variant="outline" onclick={() => { query = ''; activity = 'all'; lowStock = false; bins = []; visibleCount = 50; }}>{m.clearSearch}</Button></Empty.Content></Empty.Root>
	{:else}
		<ul class={[cardGrid, 'products m-0 min-h-40']}>
			{#each filtered.slice(0, visibleCount) as product (product.id)}<AdminProductCard {product} {references} quantity={failed || stockFailed ? null : quantity(product) ?? null} />{/each}
		</ul>
		{#if filtered.length > visibleCount}<div class="mt-6"><Button variant="outline" onclick={() => { visibleCount += 50; }}>{i18n.m.catalog.showMore}</Button></div>{/if}
	{/if}
{/if}
{#if references}<ProductReferencesEditor />{/if}
