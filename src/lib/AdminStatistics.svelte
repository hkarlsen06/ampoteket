<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readAdminStatistics, type AdminStatistics } from '#lib/admin-statistics.js';
	type Overview = NonNullable<AdminStatistics['overview']>;
	import { formatCountedAt, formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	import { productName } from '#lib/catalog.js';
	import { compareDecimals } from '#lib/decimal.js';
	import { codeText, formActions, itemTitle, nameWrap, section, sectionHeading } from '#lib/ui.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import SalesChart from '#lib/SalesChart.svelte';
	import AdminProductCard from '#lib/AdminProductCard.svelte';
	import { readAdminProducts, readProductReferences, type AdminProduct, type ProductReferences } from '#lib/admin-products.js';

	let { overview = false, productId = null, unit = '' }: { overview?: boolean; productId?: string | null; unit?: string } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminStatistics);
	let data = $state<AdminStatistics | null>(null); let attention = $state<{ products: AdminProduct[]; references: ProductReferences } | null>(null); let loading = $state(true); let failed = $state(false);
	let mounted = false; let generation = 0;
	onMount(() => { mounted = true; void load(); return () => { mounted = false; generation++; }; });
	async function load() {
		if (admin.status !== 'ready') return;
		loading = true; const version = ++generation;
		try {
			const session = admin.credentials();
			const result = await readAdminStatistics(session, productId);
			// The statistics RPC names the parts needing attention; the catalog-style cards need their full product rows.
			const ids = result.overview?.attention.map(part => part.product_id) ?? [];
			const [products, references] = ids.length ? await Promise.all([readAdminProducts(session, fetch, ids), readProductReferences(session)]) : [[], null];
			if (mounted && version === generation && admin.session?.user.id === session.userId) {
				data = result; failed = false;
				attention = references && { products: ids.map(id => products.find(p => p.id === id)).filter(p => p !== undefined), references };
			}
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(loading)) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	const metrics = $derived([
		{ label: m.saleCount, value: data ? formatDecimal(data.summary.sale_count, i18n.locale) : null },
		{ label: m.value, value: data ? formatMoney(data.summary.total_nok, i18n.locale) : null },
		...(overview ? [
			{ label: m.attention, value: data?.overview ? formatDecimal(data.overview.attention_count, i18n.locale) : null },
			{ label: m.openCounts, value: data?.overview ? formatDecimal(data.overview.open_count_count, i18n.locale) : null }
		] : productId ? [{ label: m.quantitySold, value: data?.summary.quantity !== null && data ? `${formatDecimal(data.summary.quantity, i18n.locale)} ${unitLabel(unit, i18n.locale, data.summary.quantity)}` : null }] : [])
	]);
</script>

<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<section class="space-y-4" aria-labelledby="statistics-period-title">
<h2 id="statistics-period-title" class={sectionHeading}>{m.period}</h2>
<dl class={['grid grid-cols-2 gap-x-6 gap-y-5', overview ? 'lg:grid-cols-4' : productId ? 'lg:grid-cols-3' : '']} aria-busy={loading}>
	{#each metrics as metric (metric.label)}
		<div class="min-w-0"><dt class="text-sm text-muted-foreground">{metric.label}</dt>
			<dd class="mt-2 min-h-10 font-mono text-xl font-semibold wrap-anywhere md:text-2xl">
				{#if failed}<span class="text-base font-normal">{m.unknown}</span>
				{:else if metric.value !== null}{metric.value}
				{:else}<Skeleton class="h-8 w-24 max-w-full" />{/if}
			</dd>
		</div>
	{/each}
</dl>
</section>
<div class="mt-4 empty:mt-0" aria-live="polite">
	{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button variant="outline" disabled={loading} onclick={load}>{m.retry}</Button>
	{:else if loading && !data}<span role="status" class="sr-only">{m.loading}</span>
	{:else if !overview}<p class="text-sm text-muted-foreground">{m.basis}</p>{/if}
</div>
{#if data}
	{#if overview && data.overview}
		{@render countsSection(data.overview)}
		{@render attentionSection(data.overview)}
		{#snippet attentionSection(overviewData: Overview)}
			<section class={section()} aria-labelledby="stock-attention-title">
				<h2 id="stock-attention-title" class={sectionHeading}>{m.attention}</h2>
				<div class={formActions}>
					{#if overviewData.attention.length}<Button href={i18n.href('/admin/orders?new')}>{m.openOrder}</Button>{/if}
					<Button variant="outline" href={i18n.href('/admin/products')}>{m.allProducts}</Button>
				</div>
				{#if !overviewData.attention.length}<Empty.Root><Empty.Description>{m.noAttention}</Empty.Description></Empty.Root>
				{:else if compareDecimals(overviewData.attention_count, String(overviewData.attention.length)) > 0}
					<p class="text-muted-foreground">{m.attentionShown(formatDecimal(String(overviewData.attention.length), i18n.locale), formatDecimal(overviewData.attention_count, i18n.locale))} <a href={i18n.href('/admin/products')}>{m.attentionList}</a>{m.attentionListRest}</p>
				{/if}
				{#if attention}
					<ul class="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3" aria-labelledby="stock-attention-title">
						{#each attention.products as product (product.id)}
							<AdminProductCard {product} references={attention.references} quantity={failed ? null : overviewData.attention.find(part => part.product_id === product.id)?.quantity ?? null} headingLevel={3} />
						{/each}
					</ul>
				{/if}
			</section>
		{/snippet}
		{#snippet countsSection(overviewData: Overview)}
			<section class={section()} aria-labelledby="open-counts-title">
				<h2 id="open-counts-title" class={sectionHeading}>{m.openCounts}</h2>
				{#if !overviewData.open_counts.length}<Empty.Root><Empty.Description>{m.noOpenCounts}</Empty.Description></Empty.Root>{/if}
				<Item.Group>
					{#each overviewData.open_counts as batch, index (batch.id)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0">
							<Item.Title class={itemTitle}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/counts/${batch.id}`)}>{batch.title}</a></Item.Title>
							<Item.Description>{formatCountedAt(batch.started_at, i18n.locale)}</Item.Description>
						</Item.Content></Item.Root>
					{/each}
				</Item.Group>
				<Button variant="outline" href={i18n.href('/admin/counts')}>{m.allCounts}</Button>
			</section>
		{/snippet}
	{:else}
		<SalesChart days={data.days} product={productId !== null} {unit} />
		{#if data.summary.sale_count === '0'}<Empty.Root class="mt-4"><Empty.Description>{m.emptySales}</Empty.Description></Empty.Root>{/if}
		{#if !productId && data.products.length}
			<section class={section()} aria-labelledby="top-parts-title">
				<h2 id="top-parts-title" class={sectionHeading}>{m.topProducts}</h2>
				<Item.Group>
					{#each data.products as part, index (part.product_id)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row" role="listitem">
							<Item.Content class="min-w-0 basis-48"><Item.Title class={[itemTitle, nameWrap]}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/products/${part.product_id}`)}>{productName(part, i18n.locale)}</a></Item.Title><Item.Description><span class={codeText}>{part.code}</span> · {m.sold(`${formatDecimal(part.quantity!, i18n.locale)} ${unitLabel(part.unit_code, i18n.locale, part.quantity!)}`)}</Item.Description></Item.Content>
							<p class="max-w-full font-mono wrap-anywhere">{formatMoney(part.total_nok, i18n.locale)}</p>
						</Item.Root>
					{/each}
				</Item.Group>
			</section>
		{/if}
	{/if}
{:else if !failed}
	<div class="min-h-80 space-y-4" aria-hidden="true"><Skeleton class="h-8 w-48" /><Skeleton class="h-64 w-full" /></div>
{/if}
