<script lang="ts">
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { formActions, formStatus, pageContainer, pageHeader, pageHeading, section } from '#lib/ui.js';
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { getI18n } from '#lib/i18n/index.js';
	import { CartError, getCartContext, readActiveAttempt, type CartErrorCode } from '#lib/cart.js';
	import { readCartProducts, type CartProductFact } from '#lib/cart-catalog.js';
	import { addDecimals, lineTotal } from '#lib/decimal.js';
	import { formatMoney } from '#lib/format.js';
	import CartLine from '#lib/CartLine.svelte';
	import CartNotice from '#lib/CartNotice.svelte';
	import { startCheckout, checkoutErrorCode, finishRegistration, readCheckout, type CheckoutErrorCode } from '#lib/checkout.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.cart);
	const cart = getCartContext();
	let facts = $state<Record<string, CartProductFact>>({});
	let revision = $state(0);
	let factsPending = $state(true);
	let factsRefreshQueued = false;
	let resetOpen = $state(false);
	let pending = $state(false);
	let resetDone = $state(false);
	let removed = $state(false);
	let error = $state<CartErrorCode | null>(null);
	let checkoutPending = $state(false);
	let checkoutError = $state<CheckoutErrorCode | null>(null);
	let contact = $state('');
	let readyLines = $state<Record<string, boolean>>({});
	const checkoutReady = $derived(!factsPending && $cart.status === 'ready' && !$cart.activeAttempt && $cart.lines.length > 0 && $cart.lines.every((line) => readyLines[line.product_id]));
	// Starting a checkout claims the attempt just before navigating; hide the returning-buyer notice meanwhile.
	const attempt = $derived(checkoutPending ? null : $cart.activeAttempt);
	const locked = $derived($cart.status !== 'ready' || !!$cart.activeAttempt || checkoutPending);
	const identity = $derived(JSON.stringify($cart.lines.map(({ product_id, code }) => ({ product_id, code }))));
	const factsLoaded = $derived($cart.lines.every((line) => !!facts[line.product_id]));
	// Indicative sum of per-line rounded totals at current prices; never a partial
	// number when any line's facts failed. The checkout snapshot stays authoritative.
	const total = $derived.by(() => {
		if (!factsLoaded || !$cart.lines.length) return null;
		let sum = '0';
		for (const line of $cart.lines) {
			const fact = facts[line.product_id];
			if (fact?.kind !== 'ready') return null;
			try { sum = addDecimals(sum, lineTotal(line.quantity, fact.product.sale_unit_price_nok)); }
			catch { return null; }
		}
		return sum;
	});

	onMount(() => {
		let checking = false;
		let checkQueued = false;
		let alive = true;
		async function reconcile() {
			if (!alive) return;
			if (checking) { checkQueued = true; return; }
			checking = true;
			try {
				await cart.refresh();
				const active = await readActiveAttempt();
				if (active?.checkoutId) {
					const snapshot = await readCheckout(active);
					if (snapshot.status === 'confirmed') await finishRegistration(active, snapshot);
				}
			} catch { /* Keep the cart locked and its references available for recovery. */ }
			finally {
				await cart.refresh(); checking = false;
				if (checkQueued) { checkQueued = false; void reconcile(); }
			}
		}
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			void reconcile();
			if (factsPending) factsRefreshQueued = true;
			else revision += 1;
		};
		window.addEventListener('focus', onVisible);
		window.addEventListener('online', onVisible);
		document.addEventListener('visibilitychange', onVisible);
		void reconcile();
		return () => { alive = false; window.removeEventListener('focus', onVisible); window.removeEventListener('online', onVisible); document.removeEventListener('visibilitychange', onVisible); };
	});
	$effect(() => {
		// Quantity-only changes do not repeat product reads or disturb quantity drafts.
		const lines = JSON.parse(identity);
		void revision;
		const controller = new AbortController();
		// Retain matching facts while refreshing so existing rows do not collapse.
		facts = untrack(() => Object.fromEntries(lines.filter((line: { product_id: string }) => facts[line.product_id]).map((line: { product_id: string }) => [line.product_id, facts[line.product_id]])));
		factsPending = true;
		void readCartProducts(data.catalogConfig, lines, controller.signal).then((next) => {
			if (!controller.signal.aborted) {
				for (const [id, fact] of Object.entries(next)) {
					const previous = facts[id];
					if (fact.kind === 'unavailable' && previous && 'product' in previous) fact.product = previous.product;
				}
				facts = next; factsPending = false;
				if (factsRefreshQueued) { factsRefreshQueued = false; revision += 1; }
			}
		});
		return () => controller.abort();
	});
	async function removedLine(index: number, returnFocus: boolean) {
		removed = true;
		if (!returnFocus) return;
		await tick();
		const controls = document.querySelectorAll<HTMLButtonElement>('.cart-lines .remove:not(:disabled)');
		(controls[index] ?? controls[controls.length - 1] ?? document.getElementById('cart-browse'))?.focus({ preventScroll: true });
	}
	async function reset() {
		if (pending) return;
		pending = true; error = null;
		try { await cart.resetInvalid(); resetOpen = false; resetDone = true; }
		catch (failure) { error = failure instanceof CartError ? failure.code : 'storage'; }
		finally { pending = false; }
	}
	async function proceed(event: SubmitEvent) {
		event.preventDefault();
		if (!checkoutReady || checkoutPending) return;
		checkoutPending = true; checkoutError = null;
		try {
			const attempt = await startCheckout(contact);
			await cart.refresh();
			await goto(i18n.href(attempt.checkoutId ? `/checkout/${attempt.checkoutId}` : '/checkout'));
		} catch (failure) { checkoutError = checkoutErrorCode(failure); await cart.refresh(); }
		finally { checkoutPending = false; }
	}
</script>

<svelte:head>
	<title>{m.title}</title>
	<meta name="description" content={m.description} />
	<meta property="og:title" content={m.title} />
	<meta property="og:description" content={m.description} />
	<meta name="robots" content="noindex" />
</svelte:head>

<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	<header class={pageHeader}>
		<h1 class={pageHeading}>{m.heading}</h1>
		<p class="min-h-5 text-sm text-muted-foreground">{#if $cart.status === 'ready'}{m.lines($cart.lines.length)}{/if}</p>
		<div class={formActions}><Button id="cart-browse" variant="outline" href={i18n.href('/p')}>{m.browse}</Button></div>
	</header>
	<CartNotice state={{ ...$cart, activeAttempt: attempt }} />
	<noscript><p class="text-sm text-muted-foreground">{m.noJavascript}</p></noscript>
	{#if $cart.status === 'invalid' && !$cart.activeAttempt}
		<Collapsible.Root bind:open={resetOpen} class="my-4 grid justify-items-start gap-4">
			<Collapsible.Trigger>
				{#snippet child({ props })}<Button variant="outline" {...props}>{m.reset}</Button>{/snippet}
			</Collapsible.Trigger>
			<Collapsible.Content class="grid gap-4">
				<p>{m.resetQuestion}</p>
				<div class={formActions}><Button variant="outline" type="button" disabled={pending} onclick={reset}>{m.resetConfirm}</Button><Button variant="ghost" type="button" onclick={() => { resetOpen = false; }}>{m.cancel}</Button></div>
			</Collapsible.Content>
		</Collapsible.Root>
	{/if}
	<div class={[formStatus, 'text-muted-foreground']} aria-live="polite">{#if error}<Field.Error role={undefined}>{m.errors[error]}</Field.Error>{:else if resetDone}<p>{m.resetDone}</p>{:else if removed}<p>{m.removed}</p>{/if}</div>
	{#if $cart.status === 'ready' && $cart.lines.length === 0 && !$cart.activeAttempt}
		<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
	{:else if $cart.lines.length}
		<ul class="cart-lines m-0 grid list-none gap-4 p-0">
			{#each $cart.lines as line, index (line.product_id)}
				<CartLine {line} fact={facts[line.product_id]} {locked} onremoved={(returnFocus) => removedLine(index, returnFocus)} onready={(ready) => { readyLines[line.product_id] = ready; }} onretry={() => { revision += 1; }} />
			{/each}
		</ul>
		<div class={section({ class: 'px-5' })}>
			<p class="flex min-h-8 max-w-none flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
				<strong class="font-semibold">{m.total}</strong>
				{#if total !== null}<strong class="font-mono text-xl font-semibold tabular-nums">{formatMoney(total, i18n.locale)}</strong>
				{:else if factsLoaded}<span class="text-muted-foreground">{m.totalUnavailable}</span>{/if}
			</p>
			<p class="text-sm text-muted-foreground">{m.stockNote}</p>
		</div>
	{/if}
	{#if $cart.activeAttempt || $cart.lines.length}
	<Card.Root class="mt-8 gap-3 p-5 md:p-6">
		{#if attempt}
			<div class={formActions}>
				<Button variant="default" href={i18n.href(attempt.checkoutId ? `/checkout/${attempt.checkoutId}` : '/checkout')}>{i18n.m.checkout.resume}</Button>
				<a href={i18n.href('/contact')}>{i18n.m.checkout.help}</a>
			</div>
		{:else}
			<form class="grid gap-3" onsubmit={proceed}>
				<Field.Group layout="row">
					<Field.Field width="grow" class="max-w-md">
						<Field.Label for="checkout-contact">{i18n.m.checkout.contact}</Field.Label>
						<Input id="checkout-contact" bind:value={contact} maxlength={300} autocomplete="off" inputmode="text" autocapitalize="none" enterkeyhint="go" disabled={locked} />
					</Field.Field>
					<Button variant="default" type="submit" disabled={!checkoutReady || checkoutPending}><ButtonLabel label={i18n.m.checkout.proceed} pendingLabel={i18n.m.checkout.preparing} pending={checkoutPending} /></Button>
				</Field.Group>
				<Field.Description class="empty:hidden">{#if !factsPending && !checkoutReady && $cart.lines.length}{i18n.m.checkout.reviewNeeded}{/if}</Field.Description>
			</form>
		{/if}
		<Field.Error role="status">{#if checkoutError}{i18n.m.checkout.errors[checkoutError]}{/if}</Field.Error>
	</Card.Root>
	{/if}
</div>
