<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import Icon from '$lib/Icon.svelte';
	import { productName, type CatalogProduct } from '$lib/catalog';
	import { categoryBesideName, getI18n } from '$lib/i18n';
	import ProductAvailability from '$lib/ProductAvailability.svelte';
	import { codeText, nameWrap, pageHeading } from '$lib/ui';

	let { product, headingLevel = 2, linked = true, showCategory = false, showStock = false, prominent = false, compact = false, stretchLink = false, showChevron = false }: {
		product: CatalogProduct;
		headingLevel?: 1 | 2 | 3;
		linked?: boolean;
		showCategory?: boolean;
		showStock?: boolean;
		prominent?: boolean;
		compact?: boolean;
		stretchLink?: boolean;
		showChevron?: boolean;
	} = $props();
	const i18n = getI18n();
	const category = $derived(categoryBesideName(product.category_name, productName(product, i18n.locale), i18n.locale));
</script>

<div class="min-w-0">
	<svelte:element this={`h${headingLevel}`} class={['m-0', nameWrap, prominent ? pageHeading : [compact ? 'text-base' : 'text-lg', 'font-semibold leading-snug']]}>
		{#if linked}
			<a class={['text-foreground no-underline hover:underline', stretchLink && "after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!"]} href={i18n.href(`/p/${product.code}`)}>{productName(product, i18n.locale)}{#if showChevron}<Icon icon={CaretRightIcon} class="ml-1 inline size-5 align-[calc(0.5cap-0.625rem)]" />{/if}</a>
		{:else}{productName(product, i18n.locale)}{/if}
	</svelte:element>
	<div class="product-meta mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
		<span class={codeText}>{product.code}</span>
		{#if showCategory && category}<span>{category}</span>{/if}
		{#if showStock}<ProductAvailability {product} showLocation={false} />{/if}
	</div>
</div>
