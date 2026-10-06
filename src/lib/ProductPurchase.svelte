<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import Icon from '#lib/Icon.svelte';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { formActions, formStatus } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { productName, type SaleProduct } from '#lib/catalog.js';
	import { CartError, getCartContext, type CartErrorCode } from '#lib/cart.js';
	import { addDecimals, lineTotal, normalizeDecimal, validQuantity } from '#lib/decimal.js';
	import { formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	import QuantityStepper from '#lib/QuantityStepper.svelte';
	import CartNotice from '#lib/CartNotice.svelte';

	// Shared by product details and scanner confirmation. The scanner owns only
	// camera lifecycle; quantity validation, cart writes and feedback live here.
	let { product, compact = false, unavailable = false, showCartNotice = true, onscan, onpending, onadded }: {
		product: SaleProduct;
		compact?: boolean;
		unavailable?: boolean;
		showCartNotice?: boolean;
		onscan?: () => void;
		onpending?: (pending: boolean) => void;
		onadded?: (returnFocus: boolean) => void;
	} = $props();
	const id = $props.id();
	const quantityId = $derived(compact ? `${id}-quantity` : 'quantity-to-add');
	const resultId = $derived(compact ? `${id}-result` : 'quantity-result');
	const i18n = getI18n();
	const m = $derived(i18n.m.product);
	const cart = getCartContext();
	const name = $derived(productName(product, i18n.locale));
	const already = $derived($cart.lines.find((line) => line.product_id === product.product_id)?.quantity);
	const editable = $derived($cart.status === 'ready' && !$cart.activeAttempt);
	let quantity = $state('');
	let pending = $state(false);
	let added = $state(false);
	let error = $state<CartErrorCode | null>(null);
	let stepper: QuantityStepper | undefined = $state();
	let mounted = false;
	onMount(() => { mounted = true; return () => { mounted = false; }; });
	const disabled = $derived(!editable || pending || error === 'storage');
	const addDisabled = $derived(disabled || unavailable);
	const productId = $derived(product.product_id);
	// Indicative, like the cart line; the database computes the real total.
	const total = $derived.by(() => {
		try { return lineTotal(validQuantity(quantity, product.sale_step, i18n.locale), product.sale_unit_price_nok); } catch { return null; }
	});
	$effect(() => {
		void productId;
		const locale = i18n.locale;
		untrack(() => {
			quantity = normalizeDecimal(product.sale_step).replace('.', locale === 'nb' ? ',' : '.');
			added = false; error = null;
		});
	});
	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (addDisabled) return;
		const returnFocus = event.submitter?.matches(':focus-visible') ?? false;
		pending = true; added = false; error = null; onpending?.(true);
		try {
			await cart.add(product, quantity, i18n.locale);
			if (!mounted) return;
			added = true;
			onpending?.(false);
			onadded?.(returnFocus);
		} catch (failure) {
			if (!mounted) return;
			error = failure instanceof CartError ? failure.code : 'storage';
		} finally {
			pending = false;
			if (mounted && !added) onpending?.(false);
			if (error === 'quantity') {
				await tick();
				if (mounted && error === 'quantity') stepper?.focus();
			}
		}
	}
	function step(direction: 1 | -1) {
		if (disabled) return;
		error = null; added = false;
		try {
			const current = validQuantity(quantity, product.sale_step, i18n.locale);
			quantity = validQuantity(addDecimals(current, direction === 1 ? product.sale_step : `-${product.sale_step}`), product.sale_step).replace('.', i18n.locale === 'nb' ? ',' : '.');
		} catch { error = 'quantity'; stepper?.focus(); }
	}
</script>

<form class={compact ? 'grid gap-2' : 'mt-5 grid justify-items-start'} onsubmit={add} novalidate>
	<!-- Compact puts the stepper under the thumb at the right edge and the labelled
	     total left of it; the stepper's +/− make its label visually redundant. -->
	<div class={compact ? 'flex flex-row-reverse items-end justify-between gap-4' : 'contents'}>
		<div class={compact ? 'w-40 shrink-0' : 'contents'}>
			<Field.Label class={compact ? 'sr-only' : 'mb-2'} for={quantityId}>{m.quantity}</Field.Label>
			<QuantityStepper bind:this={stepper} bind:value={quantity} id={quantityId} {disabled}
				invalid={error === 'quantity'} describedby={`${id}-step ${resultId}`}
				decreaseLabel={i18n.m.cart.decrease(name)} increaseLabel={i18n.m.cart.increase(name)}
				onstep={step} oninput={() => { added = false; if (error === 'quantity') error = null; }} />
		</div>
		{#if compact && total !== null}<p class="m-0 grid gap-1 self-center"><span class="text-sm leading-none font-medium">{`${i18n.m.cart.lineTotal} `}</span><span class="font-mono text-xl leading-none font-semibold tabular-nums">{formatMoney(total, i18n.locale)}</span></p>{/if}
	</div>
	<Field.Description id={`${id}-step`} class="sr-only">{m.step(formatDecimal(product.sale_step, i18n.locale), unitLabel(product.unit_symbol, i18n.locale, product.sale_step))}</Field.Description>
	<!-- Compact buttons share a row when both fit and otherwise each fill their own. -->
	<div class={[formActions, compact ? 'items-stretch' : 'mt-4']}>
		{#if onscan}<Button variant="outline" class={compact ? 'flex-auto' : undefined} type="button" disabled={pending} onclick={onscan}><Icon icon={QrCodeIcon} />{i18n.m.scanner.action}</Button>{/if}
		<Button variant="default" class={compact ? 'flex-[1_1_9rem]' : undefined} type="submit" disabled={addDisabled}><ButtonLabel label={m.add} pendingLabel={m.adding} {pending} /></Button>
	</div>
	<div id={resultId} class={['basket-error', compact ? 'text-sm [&:not(:has(*))]:hidden' : formStatus]} role={error ? 'alert' : 'status'}>
		{#if error}<Field.Error role={undefined}>{error === 'storage' ? i18n.m.scanner.reviewBasket : i18n.m.cart.errors[error]}{#if error === 'quantity'}{` ${m.step(formatDecimal(product.sale_step, i18n.locale), unitLabel(product.unit_symbol, i18n.locale, product.sale_step))}`}{/if}</Field.Error>
		{:else if added}<p class="text-muted-foreground">{m.added}</p>{:else if already}<p class="text-muted-foreground">{m.already(formatDecimal(already, i18n.locale), unitLabel(product.unit_symbol, i18n.locale, already))}</p>{/if}
	</div>
	{#if error === 'storage'}<a href={i18n.href('/cart')}>{m.cart}</a>{/if}
</form>
{#if showCartNotice}<CartNotice state={$cart} />{/if}
