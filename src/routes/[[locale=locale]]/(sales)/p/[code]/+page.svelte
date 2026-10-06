<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import Icon from '#lib/Icon.svelte';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import { codeText, pageContainer, pageHeader, pageHeading, sectionHeading } from '#lib/ui.js';
	import { specificationLabel, getI18n } from '#lib/i18n/index.js';
	import { onDestroy, untrack } from 'svelte';
	import { forSale, lookupCatalogProduct, productName } from '#lib/catalog.js';
	import { formatMeasurement } from '#lib/format.js';
	import { compareDecimals } from '#lib/decimal.js';
	import ProductIdentity from '#lib/ProductIdentity.svelte';
	import ProductPrice from '#lib/ProductPrice.svelte';
	import CategoryGraphic from '#lib/CategoryGraphic.svelte';
	import ProductPurchase from '#lib/ProductPurchase.svelte';
	import ShelfMap from '#lib/ShelfMap.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.product);
	let product = $state.raw(untrack(() => data.product));
	let unavailable = $state(untrack(() => data.unavailable));
	let refreshing = $state(false);
	let refreshQueued = false;
	let controller: AbortController | undefined;
	$effect(() => {
		product = data.product; unavailable = data.unavailable;
		controller?.abort(); controller = undefined; refreshing = false; refreshQueued = false;
	});
	onDestroy(() => { controller?.abort(); controller = undefined; refreshQueued = false; });
	async function refreshProduct() {
		if (document.visibilityState !== 'visible' || !data.catalogConfig) return;
		if (refreshing) { refreshQueued = true; return; }
		const own = controller = new AbortController();
		const deadline = setTimeout(() => own.abort(), 15000);
		refreshing = true;
		try {
			const latest = await lookupCatalogProduct(data.catalogConfig, product?.code ?? data.code, { signal: own.signal });
			if (controller !== own) return;
			if (latest) product = latest;
			unavailable = !latest;
		} catch { if (controller === own) unavailable = true; }
		finally {
			clearTimeout(deadline);
			if (controller === own) {
				refreshing = false;
				if (refreshQueued) { refreshQueued = false; void refreshProduct(); }
			}
		}
	}
	const name = $derived(product ? productName(product, i18n.locale) : null);
	const balanceState = $derived(product ? compareDecimals(product.quantity, '0') : null);

</script>

<svelte:window onfocus={refreshProduct} ononline={refreshProduct} />
<svelte:document onvisibilitychange={refreshProduct} />

<!-- Closed by default below 48rem; the two-column layout, and pages without
JavaScript, always show the content with a plain heading. -->
{#snippet disclosure(id: string, title: string, content: import('svelte').Snippet)}
	<Collapsible.Root class="min-w-0 md:col-start-1">
		<h2 {id} class={sectionHeading}>
			<DisclosureTrigger class="text-[length:inherit] font-[inherit] md:hidden no-js:hidden">{title}</DisclosureTrigger>
			<span class="hidden md:inline no-js:inline">{title}</span>
		</h2>
		<Collapsible.Content forceMount class="mt-2 hidden data-[state=open]:block md:block no-js:block">{@render content()}</Collapsible.Content>
	</Collapsible.Root>
{/snippet}

<svelte:head>
	<title>{m.title(name ?? m.unavailableTitle)}</title>
	<meta name="description" content={product?.description ?? name ?? m.unavailable} />
	<meta property="og:title" content={m.title(name ?? m.unavailableTitle)} />
	<meta property="og:description" content={product?.description ?? name ?? m.unavailable} />
	{#if data.unavailable}<meta name="robots" content="noindex" />{/if}
</svelte:head>

<div class={pageContainer({ padding: 'page' })}>
	<p class="mb-4"><Button variant="link" href={i18n.href('/p')}><Icon icon={ArrowLeftIcon} />{m.back}</Button></p>
	{#if product}
		<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:grid-rows-[auto_auto_1fr] md:gap-y-6 lg:gap-x-12">
			<div class="product-summary mb-6 min-w-0 md:col-start-1 md:row-start-1 md:mb-0">
				<div class="mb-6 grid grid-cols-[minmax(0,1fr)_4rem] items-center gap-3 lg:grid-cols-[minmax(0,1fr)_5rem] [&>div]:min-w-0">
					<ProductIdentity {product} headingLevel={1} linked={false} showCategory prominent showStock />
					<div class="w-16 self-start pt-1 lg:w-20"><CategoryGraphic category={product.category_name} /></div>
				</div>
				<ProductPrice {product} prominent />
				{#if !forSale(product)}<p class="mt-3">{m.borrowNote}</p>
				{:else}
					{#if balanceState !== null && balanceState <= 0}<p class="mt-3 text-sm text-muted-foreground">{m.stockNote}</p>{/if}
					{#key product.product_id}<ProductPurchase {product} unavailable={unavailable || refreshing} />{/key}
				{/if}
				{#if unavailable}
					<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message>
					<Button variant="outline" class="mt-3" disabled={refreshing} onclick={refreshProduct}>{m.retry}</Button>
				{/if}
				{#if forSale(product)}<noscript><p class="text-sm text-muted-foreground">{m.noJavascript}</p></noscript>{/if}
			</div>
			{#if product.description}
				{#snippet description()}<p class="whitespace-pre-line">{product?.description}</p>{/snippet}
				{@render disclosure('description-title', m.description, description)}
			{/if}
			<div class="product-location min-w-0 md:col-start-2 md:row-span-3 md:row-start-1">
				{#key product.product_id}<ShelfMap initialTopology={data.shelfTopology} config={data.catalogConfig} {product} />{/key}
			</div>
			<div class="details grid min-w-0 gap-6 md:col-start-1">
				{#if Object.keys(product.attributes).length}
					{#snippet specifications()}
						<Table.Root class="table-fixed">
							<Table.Body>
								{#each Object.entries(product?.attributes ?? {}) as [code, attribute] (code)}
									<Table.Row>
										<Table.Head scope="row" class="w-1/2 whitespace-normal font-normal text-muted-foreground wrap-break-word hyphens-auto">{specificationLabel(code, attribute, i18n.locale)}</Table.Head>
										<Table.Cell class={attribute.value_type === 'number' ? 'font-mono whitespace-normal wrap-anywhere' : 'whitespace-normal wrap-anywhere'}>{attribute.value_type === 'boolean' ? (attribute.value ? i18n.m.shop.yes : i18n.m.shop.no) : attribute.value_type === 'number' ? formatMeasurement(attribute.value, attribute.unit, i18n.locale) : attribute.value}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/snippet}
					{@render disclosure('specifications-title', m.specifications, specifications)}
				{/if}
				{#if product.datasheet_url}<Button variant="outline" class="justify-self-start" href={product.datasheet_url} target="_blank" rel="noreferrer">{m.datasheet}<Icon icon={ArrowUpRightIcon} /><span class="sr-only"> {i18n.m.newTab}</span></Button>{/if}
			</div>
		</div>
	{:else}
		<div class={pageHeader}>
			<h1 class={pageHeading}>{m.unavailableTitle}</h1>
			<p class={[codeText, 'text-muted-foreground']}>{data.code}</p>
		</div>
		<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
		<Button variant="outline" class="mt-3" href={i18n.href(`/p/${data.code}`)} data-sveltekit-reload>{m.retry}</Button>
	{/if}
</div>
