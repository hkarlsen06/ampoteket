<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readAdminStatistics, type AdminStatistics } from '#lib/admin-statistics.js';
	import { formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	import { productName } from '#lib/catalog.js';
	import { compareDecimals } from '#lib/decimal.js';
	import { codeText, formStatus, itemTitle, nameWrap, section, sectionHeading, cardGrid } from '#lib/ui.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
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
			const ids = overview ? result.overview?.attention.map(part => part.product_id) ?? [] : [];
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
		...(productId ? [{ label: m.quantitySold, value: data?.summary.quantity !== null && data ? `${formatDecimal(data.summary.quantity, i18n.locale)} ${unitLabel(unit, i18n.locale, data.summary.quantity)}` : null }] : [])
	]);
</script>

<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<div class={[formStatus, !failed && 'sr-only']} aria-live="polite">
	{#if failed}<Alert.Message appearance="inline" variant="destructive">{overview ? m.overviewUnavailable : m.unavailable}</Alert.Message>
	{:else if loading && !data}<span class="sr-only">{m.loading}</span>{/if}
</div>
{#if failed}<Button variant="outline" class="mb-6" disabled={loading} onclick={load}><ButtonLabel pending={loading} pendingLabel={m.loading} label={m.retry} /></Button>{/if}
{#if overview}
	<section class={section()} aria-labelledby="stock-attention-title">
		<h2 id="stock-attention-title" class={sectionHeading}>{m.attention}</h2>
		<Button href={i18n.href('/admin/orders?new')}>{m.openOrder}</Button>
		{#if data?.overview}
			{@const overviewData = data.overview}
			{#if !overviewData.attention.length}<Empty.Root><Empty.Description>{m.noAttention}</Empty.Description></Empty.Root>{/if}
			{#if attention}
				<ul class={cardGrid} aria-labelledby="stock-attention-title">
					{#each attention.products as product (product.id)}
						<AdminProductCard {product} references={attention.references} quantity={overviewData.attention.find(part => part.product_id === product.id)?.quantity ?? null} headingLevel={3} />
					{/each}
				</ul>
			{/if}
			{#if compareDecimals(overviewData.attention_count, String(overviewData.attention.length)) > 0}
				<Button variant="link" href={i18n.href('/admin/products')}>{m.attentionList}</Button>
			{/if}
		{:else if !failed}<Skeleton class="h-48 w-full" />{/if}
	</section>
	<section class={[section(), 'mb-8']} aria-labelledby="open-counts-title">
		<h2 id="open-counts-title" class={sectionHeading}>{m.openCounts}</h2>
		{#if data?.overview}
			{#if !data.overview.open_counts.length}<Empty.Root><Empty.Description>{m.noOpenCounts}</Empty.Description></Empty.Root>
			{:else}
				<ul class="list-none space-y-3 p-0">
					{#each data.overview.open_counts as count (count.id)}<li><Button variant="link" href={i18n.href(`/admin/counts/${count.id}`)}>{count.title}</Button></li>{/each}
				</ul>
				{#if compareDecimals(data.overview.open_count_count, String(data.overview.open_counts.length)) > 0}<Button variant="link" href={i18n.href('/admin/counts')}>{m.allCounts}</Button>{/if}
			{/if}
		{:else if !failed}<Skeleton class="h-16 w-full" />{/if}
	</section>
{/if}
<section class="space-y-4" aria-labelledby="statistics-period-title">
<h2 id="statistics-period-title" class={sectionHeading}>{m.period}</h2>
<dl class={['grid grid-cols-2 gap-x-6 gap-y-5', productId ? 'lg:grid-cols-3' : '']} aria-busy={loading}>
	{#each metrics as metric (metric.label)}
		<div class="min-w-0"><dt class="text-sm text-muted-foreground">{metric.label}</dt>
			<dd class="mt-2 min-h-10 font-mono text-xl font-semibold wrap-anywhere md:text-2xl">
				{#if metric.value !== null}{metric.value}
				{:else if failed}<span class="text-base font-normal">{m.unknown}</span>
				{:else}<Skeleton class="h-8 w-24 max-w-full" />{/if}
			</dd>
		</div>
	{/each}
</dl>
{#if overview}<Button variant="link" href={i18n.href('/admin/statistics')}>{m.allStatistics}</Button>{/if}
</section>
{#if !overview}<p class="mt-4 mb-8 text-sm text-muted-foreground">{m.basis}</p>{/if}
{#if data && !overview}
	<div class="mt-8"><SalesChart days={data.days} product={productId !== null} {unit} /></div>
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
{:else if !failed && !overview}
	<div class="min-h-80 space-y-4" aria-hidden="true"><Skeleton class="h-8 w-48" /><Skeleton class="h-64 w-full" /></div>
{/if}
