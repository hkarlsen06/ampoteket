<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formActions, formStatus, pageHeader, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as Popover from '$lib/components/ui/popover';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getI18n } from '$lib/i18n';
	import Icon from '$lib/Icon.svelte';
	import SortAscendingIcon from 'phosphor-svelte/lib/SortAscendingIcon';
	import { productSearchText } from '$lib/catalog-search';
	import { productName } from '$lib/catalog';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import AdminProductCard from '$lib/AdminProductCard.svelte';
	import AdminProductScanner from '$lib/AdminProductScanner.svelte';
	import { compareAttention, readAdminProducts, readInventory, readProductCommand, readProductReferences, type AdminProduct, type ProductCommand, type ProductStock, type ProductReferences } from '$lib/admin-products';
	import ProductReferencesEditor from '$lib/ProductReferences.svelte';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	let products = $state<AdminProduct[] | null>(null); let references = $state<ProductReferences | null>(null); let stock = $state<Map<string, ProductStock> | null>(null); let busy = $state(false); let failed = $state(false); let query = $state(''); let activity = $state('all'); let sort = $state<keyof typeof sorters>('attention'); let sortOpen = $state(false); let pending = $state<ProductCommand | null>(null); let alive = true;
	// Products load in code order and sorting is stable, so code breaks every tie.
	const quantity = (p: AdminProduct) => stock?.get(p.id)?.quantity;
	const sorters = {
		attention: (a: AdminProduct, b: AdminProduct) => compareAttention(a, quantity(a), b, quantity(b)),
		// Never-counted products first; ISO timestamps compare as text.
		counted: (a: AdminProduct, b: AdminProduct) => (stock?.get(a.id)?.last_counted_at ?? '').localeCompare(stock?.get(b.id)?.last_counted_at ?? ''),
		code: () => 0,
		name: (a: AdminProduct, b: AdminProduct) => productName(a, i18n.locale).localeCompare(productName(b, i18n.locale), i18n.locale),
	};
	const filtered = $derived((products ?? []).filter(p => (activity === 'all' || p.is_active === (activity === 'active')) && productSearchText(p).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort(sorters[sort]));
	onMount(() => {
		try { pending = readProductCommand(sessionStorage); } catch { /* The editor reports blocked persistence before any write. */ }
		void load();
		return () => { alive = false; };
	});
	function openProduct(id: string) { void goto(i18n.href(`/admin/products/${id}`)); }
	async function load() {
		if (busy) return; busy = true; failed = false; const session = admin.credentials();
		// A failed stock read shows as unavailable per card instead of hiding the product list.
		try { const [items, refs, inventory] = await Promise.all([readAdminProducts(session), readProductReferences(session), readInventory(session).catch(() => null)]); if (alive && session.userId === admin.session?.user.id) { products = items.sort((a, b) => a.code.localeCompare(b.code)); references = refs; stock = inventory && new Map(inventory.map(s => [s.product_id, s])); } }
		catch (error) { if (alive) failed = true; await admin.permissionFailure(error); } finally { if (alive) busy = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read when the tab
	// becomes relevant again instead of offering a manual refresh button.
	function revalidate() { if (admin.status === 'ready' && document.visibilityState === 'visible') void load(); }
</script>
<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} />
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
		<Alert.Message appearance="inline" role="status">{m.pending}</Alert.Message>
		<Button variant="link" href={i18n.href(`/admin/products/${pending.payload.id}`)}>{m.resume}</Button>
	</div>
{/if}
<Field.Group layout="row" class="filters mb-6">
	<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.search}</Field.Label><Input id={`${fieldId}-1`} type="search" bind:value={query} /></Field.Field>
	<Field.Set class="w-auto gap-2">
		<Field.Legend id="products-state-label" variant="label">{m.stateFilter}</Field.Legend>
		<ToggleGroup.Root type="single" variant="outline" value={activity} onValueChange={(value) => { if (value) activity = value; }} aria-labelledby="products-state-label">
			<ToggleGroup.Item value="all">{m.all}</ToggleGroup.Item>
			<ToggleGroup.Item value="active">{m.active}</ToggleGroup.Item>
			<ToggleGroup.Item value="inactive">{m.inactive}</ToggleGroup.Item>
		</ToggleGroup.Root>
	</Field.Set>
	<Popover.Root bind:open={sortOpen}>
		<Popover.Trigger>{#snippet child({ props })}<Button {...props} variant="outline" size="icon" class="ml-auto rounded-lg" aria-label={m.sortCurrent(m.sort[sort])}><Icon icon={SortAscendingIcon} class="size-5" /></Button>{/snippet}</Popover.Trigger>
		<Popover.Content align="end" class="w-auto max-w-[calc(100vw-2rem)]">
			<Field.Set class="gap-2">
				<Field.Legend id="products-sort-label" variant="label">{m.sortBy}</Field.Legend>
				<!-- Tapping (or Space on) an option chooses it and closes; arrow keys browse without closing. -->
				<RadioGroup.Root value={sort} onValueChange={(value) => { sort = value as keyof typeof sorters; }} aria-labelledby="products-sort-label">
					{#each Object.keys(sorters) as key (key)}
						<Field.Field orientation="horizontal"><RadioGroup.Item id={`${fieldId}-sort-${key}`} value={key} onclick={() => { sortOpen = false; }} /><Field.Label for={`${fieldId}-sort-${key}`} class="font-normal">{m.sort[key as keyof typeof sorters]}</Field.Label></Field.Field>
					{/each}
				</RadioGroup.Root>
			</Field.Set>
		</Popover.Content>
	</Popover.Root>
</Field.Group>
<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
{#if failed}<Button type="button" variant="outline" disabled={busy} onclick={load}>{m.retry}</Button>{/if}
{#if products === null && busy}
	<span class="sr-only" role="status">{m.loading}</span>
	<div class="grid min-h-80 grid-cols-1 content-start gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy={busy}>
		{#each [1, 2, 3] as row (row)}<Skeleton class="h-40 rounded-xl" aria-hidden="true" />{/each}
	</div>
{/if}
{#if products !== null && !failed}
	{#if !filtered.length}
		<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
	{:else}
		<ul class="products m-0 grid min-h-40 list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3" aria-label={m.heading}>
			{#each filtered as product (product.id)}<AdminProductCard {product} {references} quantity={quantity(product) ?? null} />{/each}
		</ul>
	{/if}
{/if}
{#if references}<ProductReferencesEditor onrefresh={(value) => { references = value; }} />{/if}
