<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formActions, pageHeader, pageHeading, cardGrid } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import { untrack, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Toggle } from '#lib/components/ui/toggle/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import Icon from '#lib/Icon.svelte';
	import SortAscendingIcon from 'phosphor-svelte/lib/SortAscendingIcon';
	import { matchesSearch, searchTerms } from '#lib/catalog-search.js';
	import { productName } from '#lib/catalog.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import AdminProductCard from '#lib/AdminProductCard.svelte';
	import AdminProductScanner from '#lib/AdminProductScanner.svelte';
	import { adminSearchTexts, compareAttention, stockRank, readAdminProducts, readAllProductAttributes, readInventory, readProductCommand, readProductReferences, type AdminProduct, type ProductCommand, type ProductStock, type ProductReferences } from '#lib/admin-products.js';
	import ProductReferencesEditor from '#lib/ProductReferences.svelte';
	import { readDraft, writeDraft } from '#lib/drafts.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	let products = $state<AdminProduct[] | null>(null); let references = $state<ProductReferences | null>(null); let searchTexts = new Map<string, string>(); let stock = $state<Map<string, ProductStock> | null>(null); let stockFailed = $state(false); let busy = $state(false); let failed = $state(false); let query = $state(''); let lowStock = $state(false); let activity = $state('all'); let sort = $state<keyof typeof sorters>('attention'); let sortOpen = $state(false); let pending = $state<ProductCommand | null>(null); let alive = true;
	// Products load in code order and sorting is stable, so code breaks every tie.
	const quantity = (p: AdminProduct) => stock?.get(p.id)?.quantity;
	const sorters = {
		attention: (a: AdminProduct, b: AdminProduct) => compareAttention(a, quantity(a), b, quantity(b)),
		// Never-counted products first; ISO timestamps compare as text.
		counted: (a: AdminProduct, b: AdminProduct) => (stock?.get(a.id)?.last_counted_at ?? '').localeCompare(stock?.get(b.id)?.last_counted_at ?? ''),
		code: () => 0,
		name: (a: AdminProduct, b: AdminProduct) => productName(a, i18n.locale).localeCompare(productName(b, i18n.locale), i18n.locale),
	};
	// Search, state and sort survive Back and reload in this tab. Admin pages mount
	// after Auth, too late for a SvelteKit snapshot to restore on reload.
	let viewLoaded = $state(false);
	let visibleCount = $state(50);
	$effect(() => {
		if (!viewLoaded) return;
		writeDraft(admin.session?.user.id, 'products-view', query || activity !== 'all' || lowStock || sort !== 'attention' || visibleCount > 50 ? { query, activity, lowStock, sort, visibleCount } : null, 'session');
	});
	// Low stock matches the overview's attention list: active and sold out or below minimum.
	const terms = $derived(searchTerms(query));
	const filtered = $derived((products ?? []).filter(p => (activity === 'all' || p.is_active === (activity === 'active')) && (!lowStock || stockRank(p, quantity(p)) <= 1) && matchesSearch(searchTexts.get(p.id) ?? '', terms)).sort(sorters[sort]));
	let reading = $state(false);
	let currentRead: Promise<void> | null = null;
	onMount(() => {
		try { pending = readProductCommand(sessionStorage); } catch { /* The editor reports blocked persistence before any write. */ }
		const view = readDraft(admin.session?.user.id, 'products-view', 'session') as Record<string, unknown> | null;
		if (typeof view?.query === 'string' && ['all', 'active', 'inactive'].includes(view.activity as string) && typeof view.sort === 'string' && Object.hasOwn(sorters, view.sort)) {
			query = view.query; activity = view.activity as string; sort = view.sort as keyof typeof sorters; lowStock = view.lowStock === true;
			if (typeof view.visibleCount === 'number' && Number.isSafeInteger(view.visibleCount) && view.visibleCount >= 50) visibleCount = view.visibleCount;
		}
		// The overview links here for everything needing attention, not only its first eight.
		if (page.url.searchParams.get('stock') === 'low') { query = ''; activity = 'all'; lowStock = true; sort = 'attention'; visibleCount = 50; }
		viewLoaded = true;
		void load();
		return () => { alive = false; };
	});
	function openProduct(id: string) { void goto(i18n.href(`/admin/products/${id}`)); }
	function load(background = false) {
		if (admin.status !== 'ready') return Promise.resolve();
		if (reading) { if (!background) busy = true; return currentRead ?? Promise.resolve(); }
		reading = true; busy = !background;
		return currentRead = loadProducts();
	}
	async function loadProducts() {
		// A failed stock read shows as unavailable per card instead of hiding the product list.
		try { const session = admin.credentials(); const [items, refs, attributes, inventory] = await Promise.all([readAdminProducts(session), readProductReferences(session), readAllProductAttributes(session), readInventory(session).catch(error => { void admin.permissionFailure(error); return null; })]); if (alive && session.userId === admin.session?.user.id) { searchTexts = adminSearchTexts(items, refs, attributes); products = items.sort((a, b) => a.code.localeCompare(b.code)); references = refs; if (inventory) stock = new Map(inventory.map(s => [s.product_id, s])); stockFailed = inventory === null; failed = false; } }
		catch (error) { if (alive) failed = true; await admin.permissionFailure(error); } finally { if (alive) { busy = false; reading = false; } }
	}
	function retryInventory() {
		if (admin.status !== 'ready') return Promise.resolve();
		if (reading) { busy = true; return currentRead ?? Promise.resolve(); }
		reading = true; busy = true;
		return currentRead = loadInventory();
	}
	async function loadInventory() {
		try {
			const session = admin.credentials(); const inventory = await readInventory(session);
			if (alive && session.userId === admin.session?.user.id) { stock = new Map(inventory.map(item => [item.product_id, item])); stockFailed = false; }
		} catch (error) { stockFailed = true; await admin.permissionFailure(error); }
		finally { if (alive) { busy = false; reading = false; } }
	}
	// The app owns freshness (design-system.md §4.2): re-read when the tab
	// becomes relevant again instead of offering a manual refresh button.
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !reading) {
			revalidateQueued = false;
			untrack(() => { void load(true); });
		}
	});
</script>
<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
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
{#if failed || stockFailed}<Alert.Message appearance="inline" variant="destructive" role="alert">{failed ? m.unavailable : m.inventoryUnavailable}</Alert.Message><Button type="button" variant="outline" disabled={busy} onclick={() => failed ? load() : retryInventory()}>{m.retry}</Button>{/if}
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
		<Empty.Root><Empty.Description>{m.empty}</Empty.Description><Empty.Content><Button variant="outline" onclick={() => { query = ''; activity = 'all'; lowStock = false; visibleCount = 50; }}>{m.clearSearch}</Button></Empty.Content></Empty.Root>
	{:else}
		<ul class={[cardGrid, 'products m-0 min-h-40']}>
			{#each filtered.slice(0, visibleCount) as product (product.id)}<AdminProductCard {product} {references} quantity={failed || stockFailed ? null : quantity(product) ?? null} />{/each}
		</ul>
		{#if filtered.length > visibleCount}<div class="mt-6"><Button variant="outline" onclick={() => { visibleCount += 50; }}>{i18n.m.catalog.showMore}</Button></div>{/if}
	{/if}
{/if}
{#if references}<ProductReferencesEditor onrefresh={(value) => { references = value; }} />{/if}
