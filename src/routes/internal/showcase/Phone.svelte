<script lang="ts">
	// The showcase's phone screen. The showcase mounts it inside a 360 px iframe, so
	// the real buyer components see a phone viewport and lay themselves out exactly
	// as on a phone. `screen` (0–3) picks the screen.
	import { onMount } from 'svelte';
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import Icon from '#lib/Icon.svelte';
	import ProductIdentity from '#lib/ProductIdentity.svelte';
	import ProductPrice from '#lib/ProductPrice.svelte';
	import ProductAvailability from '#lib/ProductAvailability.svelte';
	import StockBadge from '#lib/StockBadge.svelte';
	import StateBadge from '#lib/StateBadge.svelte';
	import CartLine from '#lib/CartLine.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { messagesFor, setI18n } from '#lib/i18n/index.js';
	import { createCartStore, setCartContext } from '#lib/cart.js';
	import { formatMoney } from '#lib/format.js';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import * as data from './fixtures';

	const i18n = setI18n({ locale: 'nb', m: messagesFor('nb'), href: (path: string) => path });
	const m = i18n.m;
	let savedCart = JSON.stringify(data.cartLines);
	const cart = setCartContext(createCartStore({
		read: () => savedCart, write: (value) => { savedCart = value; }, readAttempt: async () => null,
		lock: (operation) => operation(), listen: () => () => {}, notify: () => {}
	}));
	const facts = Object.fromEntries(data.cartProducts.map((product) => [product.product_id, { kind: 'ready' as const, product }]));

	let { screen }: { screen: number } = $props();
	// The drawer's stock drops as the purchase registers.
	const stock = new Tween(84);
	$effect(() => {
		if (screen === 3) void stock.set(84, { duration: 0 }).then(() => stock.set(74, { duration: 1600, delay: 900, easing: cubicOut }));
	});
	onMount(() => cart.start());
</script>

{#snippet find()}
	<h1 class="text-2xl font-semibold">{m.catalog.heading}</h1>
	<div class="relative"><Icon icon={MagnifyingGlassIcon} size={18} class="absolute top-1/2 left-3 -mt-[9px] text-muted-foreground" /><Input class="pl-9" value="motstand" readonly aria-label={m.catalog.searchLabel} /></div>
	<ul class="grid divide-y divide-border">
		{#each data.search as product (product.code)}
			<li class={['grid gap-2 py-3', product === data.resistor && '-mx-3 rounded-lg bg-muted px-3']}>
				<ProductIdentity {product} linked={false} compact headingLevel={2} />
				<ProductPrice {product} compact />
				<ProductAvailability {product} inline />
			</li>
		{/each}
	</ul>
{/snippet}
{#snippet fill()}
	<h1 class="text-2xl font-semibold">{m.cart.heading}</h1>
	<ul class="grid gap-3">
		{#each $cart.lines as line (line.product_id)}<CartLine {line} fact={facts[line.product_id]} locked={false} onremoved={() => {}} />{/each}
	</ul>
{/snippet}
{#snippet pay()}
	<h1 class="text-2xl font-semibold">{m.checkout.heading}</h1>
	<p class="flex items-baseline justify-between border-y border-border py-3"><strong class="font-semibold">{m.checkout.total}</strong><strong class="font-mono text-xl font-semibold tabular-nums">{formatMoney(data.cartTotal, 'nb')}</strong></p>
	<p>{m.checkout.recipient}: <strong class="font-mono">47322</strong></p>
	<img class="mx-auto size-[200px] rounded-lg bg-[var(--paper)] p-2" src="/payments/vipps-47322.svg" alt={m.checkout.qrAlt} />
	<Button variant="outline" class="h-11">{m.checkout.openVipps}</Button>
	<Button class="h-auto min-h-11 py-2 whitespace-normal">{m.checkout.paid}</Button>
{/snippet}
{#snippet done()}
	<StateBadge tone="success" class="justify-self-start"><Icon icon={CheckCircleIcon} size={16} weight="fill" />{m.checkout.registered}</StateBadge>
	<p class="text-sm text-muted-foreground">{m.checkout.registeredNote}</p>
	<div class="grid gap-3 rounded-lg border border-border p-4">
		<ProductIdentity product={data.resistor} linked={false} compact headingLevel={2} />
		<StockBadge quantity={String(Math.round(stock.current))} unit="stk" />
	</div>
{/snippet}

<div class="fixed inset-0 overflow-hidden bg-background text-foreground">
	<div class="relative z-10 flex h-14 items-center justify-between border-b border-border bg-background px-5">
		<picture><source srcset="/brand/wordmark-light.svg" media="(prefers-color-scheme: light)" /><img class="h-4" src="/brand/wordmark.svg" alt="Ampoteket" /></picture>
		<span class="text-xs text-muted-foreground">ampoteket.no</span>
	</div>
	<!-- The screens follow each other like a feed. -->
	{#each [find, fill, pay, done] as content, index (index)}
		<div class="absolute inset-x-0 top-14 bottom-0 grid content-start gap-4 overflow-hidden p-5 transition-[translate] duration-700 ease-[cubic-bezier(.65,0,.35,1)] motion-reduce:transition-none"
			style:translate="0 {(index - screen) * 100}%" aria-hidden={index !== screen}>{@render content()}</div>
	{/each}
</div>
