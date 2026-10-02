<script lang="ts">
	import { Separator } from '#lib/components/ui/separator/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
	import Icon from '#lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import CheckoutReferences from '#lib/CheckoutReferences.svelte';
	import { codeText, formActions, itemTitle, nameWrap, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { getI18n } from './i18n';
	import { getCartContext, type ActiveAttempt } from './cart';
	import {
		canOpenPayment, checkoutErrorCode, confirmCheckout, findCheckoutAttempt, finishRegistration,
		prepareCheckout, readCheckout, resumeCheckout, sendCheckoutReceipt, setAsideCheckout, type CheckoutErrorCode
	} from './checkout';
	import type { CheckoutSnapshot } from './checkout-contract';
	import { formatDecimal, formatMeasurementText, formatMoney, unitLabel } from './format';

	let { checkoutId }: { checkoutId?: string } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.checkout);
	const cart = getCartContext();
	let attempt = $state<ActiveAttempt | null>(null);
	let snapshot = $state<CheckoutSnapshot | null>(null);
	let busy = $state<'loading' | 'preparing' | 'confirming' | null>('loading');
	let refreshing = $state(false);
	let reconcileQueued = false;
	let error = $state<CheckoutErrorCode | null>(null);
	let asideOpen = $state(false);
	let asideDone = $state(false);
	let paymentHeight = $state(0);
	let linesHeight = $state(0);
	let generation = 0;
	let receiptEmail = $state('');
	let receipt = $state<'sending' | 'sent' | 'invalid' | 'failed' | null>(null);
	let sentTo = $state('');
	let messageCopied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	const active = $derived($cart.activeAttempt?.requestId === attempt?.requestId ? $cart.activeAttempt : null);
	const registered = $derived(snapshot?.status === 'confirmed');
	const confirmationAttempted = $derived(attempt?.state === 'confirming' || active?.state === 'confirming' || active?.state === 'registered');
	const canAct = $derived(!!snapshot && !registered && !busy && !error && $cart.status === 'ready' && !!active && active.checkoutId === snapshot.checkout_id);
	const canPay = $derived(canAct && active?.state === 'prepared' && !confirmationAttempted);
	const canRetryConfirm = $derived(!!snapshot && !registered && !busy && confirmationAttempted && !!active && !['credentials', 'missing', 'storage'].includes(error ?? ''));
	const reference = $derived(checkoutId ?? attempt?.checkoutId);
	const savedAttempt = $derived(attempt ?? (!checkoutId || $cart.activeAttempt?.checkoutId === checkoutId ? $cart.activeAttempt : null));
	const lineCount = $derived(snapshot?.items.length ?? savedAttempt?.cartLines?.length ?? 1);
	const sharedAttempt = $derived(`${$cart.activeAttempt?.requestId ?? ''}:${$cart.activeAttempt?.state ?? ''}`);

	$effect(() => {
		const id = checkoutId;
		untrack(() => { attempt = null; snapshot = null; asideDone = false; refreshing = false; reconcileQueued = false; void load(id); });
		return () => { generation += 1; };
	});
	$effect(() => {
		const shared = sharedAttempt;
		untrack(() => {
			if (snapshot && !registered && attempt && shared !== `${attempt.requestId}:prepared`) void reconcile();
		});
	});
	async function reconcile() {
		if (document.visibilityState !== 'visible') return;
		if (busy || refreshing) { reconcileQueued = true; return; }
		if (!attempt?.checkoutId) return;
		await load(checkoutId, true);
	}
	function reconcilePending() {
		if (reconcileQueued && !busy && !refreshing) { reconcileQueued = false; void reconcile(); }
	}
	async function load(id = checkoutId, background = false) {
		const run = ++generation;
		if (background) refreshing = true;
		else { busy = 'loading'; error = null; asideOpen = false; }
		try {
			let saved = await findCheckoutAttempt(id);
			if (run !== generation) return;
			attempt = saved;
			if (!saved) { error = 'missing'; return; }
			if (!saved.checkoutId) {
				busy = 'preparing';
				saved = await prepareCheckout(saved);
				if (run !== generation) return;
				attempt = saved;
			}
			if (!id) {
				await cart.refresh();
				if (run === generation) await goto(i18n.href(`/checkout/${saved.checkoutId}`), { replace: true });
				return;
			}
			const result = await readCheckout(saved);
			if (run !== generation) return;
			snapshot = result; error = null;
			if (result.status === 'confirmed') {
				const completed = await finishRegistration(saved, result);
				if (run !== generation) return;
				attempt = completed;
			} else {
				// A concurrent confirmation is never downgraded by an unconfirmed read.
				const latest = await findCheckoutAttempt(id);
				if (run !== generation) return;
				attempt = latest ?? saved;
			}
		} catch (failure) {
			if (run === generation) error = checkoutErrorCode(failure);
		} finally {
			await cart.refresh();
			if (run === generation) { busy = null; refreshing = false; reconcilePending(); }
		}
	}
	async function register() {
		if (!attempt || refreshing || (!canAct && !canRetryConfirm)) return;
		const saved = attempt;
		const run = ++generation;
		busy = 'confirming'; error = null; asideOpen = false;
		try {
			const result = await confirmCheckout(saved);
			if (run !== generation) return;
			snapshot = result;
			const completed = await finishRegistration(saved, result);
			if (run === generation) attempt = completed;
		} catch (failure) {
			if (run !== generation) return;
			error = checkoutErrorCode(failure);
			try {
				const latest = await findCheckoutAttempt(saved.checkoutId);
				if (run === generation && latest) attempt = latest;
			} catch { /* Keep the original reference available when storage is denied. */ }
		} finally {
			await cart.refresh();
			if (run === generation) { busy = null; reconcilePending(); }
		}
	}
	async function openVipps(event: MouseEvent) {
		event.preventDefault();
		if (!attempt || refreshing || !canPay || !snapshot?.payment_required) return;
		try {
			// Remote staff recovery cannot update this browser's local pointer.
			// Read the original checkout before opening payment, outside the cart lock.
			const saved = attempt;
			const checking = load(checkoutId, true);
			const run = generation;
			await checking;
			if (run !== generation || attempt?.requestId !== saved.requestId || refreshing || !canPay || !snapshot?.payment_required) return;
			const allowed = await canOpenPayment(saved);
			if (run !== generation || refreshing) return;
			if (allowed && canPay) window.location.assign('https://qr.vipps.no/vp/swDrxGWcp');
			else { error = 'conflict'; await cart.refresh(); }
		} catch (failure) { error = checkoutErrorCode(failure); }
	}
	async function setAside() {
		if (!attempt || refreshing || !canPay) return;
		busy = 'loading'; error = null;
		try { await setAsideCheckout(attempt); asideDone = true; asideOpen = false; }
		catch (failure) { error = checkoutErrorCode(failure); }
		finally { await cart.refresh(); busy = null; reconcilePending(); }
	}
	async function resume() {
		if (!attempt || busy) return;
		busy = 'loading'; error = null;
		try { attempt = await resumeCheckout(attempt); asideDone = false; await load(); }
		catch (failure) { error = checkoutErrorCode(failure); }
		finally { await cart.refresh(); busy = null; reconcilePending(); }
	}
	async function sendReceipt(event: SubmitEvent) {
		event.preventDefault();
		const email = receiptEmail.trim();
		if (!attempt || receipt === 'sending' || (receipt === 'sent' && email === sentTo)) return;
		receipt = 'sending';
		receipt = await sendCheckoutReceipt(attempt, email);
		if (receipt === 'sent') sentTo = email;
	}
	// Same text in both locales so the accounts can search Vipps for it.
	const vippsMessage = $derived(snapshot ? `Ref: ${snapshot.checkout_id}` : '');
	// No clipboard (insecure context, denied permission): the message stays visible to type.
	async function copyMessage() {
		try { await navigator.clipboard.writeText(vippsMessage); } catch { return; }
		messageCopied = true; clearTimeout(copiedTimer); copiedTimer = setTimeout(() => (messageCopied = false), 2000);
	}
	const money = (value: string) => formatMoney(value, i18n.locale);
</script>

<svelte:window onfocus={reconcile} ononline={reconcile} />
<svelte:document onvisibilitychange={reconcile} />

<svelte:head>
	<title>{m.title}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>
	<Alert.Root appearance="inline" class="min-h-20 content-start gap-2 pb-4 text-base" role={undefined} aria-live="polite" aria-atomic="true">
		{#if registered}<Alert.Title class="text-base font-semibold">{m.registered}</Alert.Title>{/if}
		<Alert.Description class={registered ? undefined : 'text-base text-foreground'}>
			{#if registered}{m.registeredNote}
			{:else if busy === 'confirming'}{m.pending}
			{:else if confirmationAttempted}{m.confirming}
			{:else if busy === 'preparing'}{m.preparing}
			{:else if busy}<span class="sr-only">{m.loading}</span>
			{:else if error}{m.needsAttention}
			{:else if asideDone}{m.setAsideDone}
			{:else if snapshot && active}<span class="sr-only">{m.prepared}</span>
			{:else if snapshot}{m.otherAttempt}{/if}
		</Alert.Description>
	</Alert.Root>
	<CheckoutReferences checkoutId={reference} requestId={attempt?.requestId} class={['mb-4 md:grid-cols-2', (reference || attempt?.requestId || !error) && 'min-h-28 md:min-h-16']} />
	<noscript><p>{m.noJavascript}</p><a href={i18n.href('/contact')}>{m.help}</a></noscript>
	<div class="saved-lines" style:min-height={!snapshot && !busy && !error && linesHeight ? `${linesHeight}px` : undefined} aria-busy={!snapshot && !!busy}>
		{#if snapshot}
			<Item.Group>
				{#each snapshot.items as item, index (item.product_id)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row" role="listitem">
							<Item.Content class="gap-0">
								<p class={[itemTitle, nameWrap]}>{formatMeasurementText(i18n.locale === 'nb' ? item.name_nb : item.name_en, i18n.locale)}</p>
								<p class={[codeText, 'mt-1 text-muted-foreground']}>{item.code}</p>
								<dl class="mt-3 mb-0 grid gap-x-6 gap-y-2 md:grid-cols-3">
									{#each [
										{ label: m.quantity, value: `${formatDecimal(item.quantity, i18n.locale)} ${unitLabel(item.unit, i18n.locale, item.quantity)}` },
										{ label: m.unitPrice, value: money(item.unit_price_nok) },
										{ label: m.lineTotal, value: money(item.line_total_nok) }
									] as fact, index (fact.label)}
										<div class={['flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 md:grid md:content-start', index === 2 && 'md:text-right']}>
											<dt class="text-sm text-muted-foreground">{fact.label}</dt>
											<dd class={['m-0 font-mono text-right tabular-nums md:text-left', index === 2 && 'font-semibold md:text-right']}>{fact.value}</dd>
										</div>
									{/each}
								</dl>
							</Item.Content>
						</Item.Root>
				{/each}
			</Item.Group>
			<Separator />
			<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-6"><strong class="font-semibold">{m.total}</strong><strong class="font-mono text-xl font-semibold tabular-nums">{money(snapshot.total_nok)}</strong></div>
		{:else if busy}
			<div aria-hidden="true" bind:clientHeight={linesHeight}>
				<Item.Group>
					{#each Array(lineCount) as _, index (index)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row">
							<Item.Content class="gap-0">
								<Skeleton class={`${itemTitle} h-lh w-3/4`} />
								<Skeleton class={`${codeText} mt-1 h-lh w-1/3`} />
								<dl class="mt-3 mb-0 grid gap-x-6 gap-y-2 md:grid-cols-3">
									{#each [m.quantity, m.unitPrice, m.lineTotal] as label, index (label)}
										<div class={['flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 md:grid md:content-start', index === 2 && 'md:text-right']}>
											<dt class="text-sm text-muted-foreground">{label}</dt>
											<dd class={['m-0', index === 2 && 'md:justify-self-end']}><Skeleton class="h-6 w-20" /></dd>
										</div>
									{/each}
								</dl>
							</Item.Content>
						</Item.Root>
					{/each}
				</Item.Group>
				<Separator />
				<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-6"><strong class="font-semibold">{m.total}</strong><Skeleton class="h-7 w-28" /></div>
			</div>
		{/if}
	</div>
	<div class={['purchase-actions mt-4 grid justify-items-start gap-4', !error && 'min-h-20', (confirmationAttempted || busy === 'confirming') && 'content-end']} style:min-height={!registered && paymentHeight ? `${paymentHeight}px` : undefined}>
		{#if registered && !busy && !error && !active}
			{#if attempt?.checkoutId === snapshot?.checkout_id}
				<form class="grid w-full gap-3" onsubmit={sendReceipt} novalidate>
					<Field.Group layout="row">
						<Field.Field width="grow" class="max-w-md">
							<Field.Label for="receipt-email">{m.receiptEmail}</Field.Label>
							<Input id="receipt-email" type="email" autocomplete="email" enterkeyhint="send" maxlength={254} bind:value={receiptEmail}
								aria-invalid={receipt === 'invalid'} aria-describedby={receipt === 'invalid' || receipt === 'failed' ? 'receipt-error' : undefined}
								oninput={() => { if (receipt !== 'sending') receipt = null; }} />
						</Field.Field>
						<Button variant="outline" type="submit" disabled={receipt === 'sending'}>
							{#if receipt === 'sent' && receiptEmail.trim() === sentTo}<Icon icon={CheckIcon} />{m.receiptSent}
							{:else}<ButtonLabel label={m.sendReceipt} pendingLabel={m.sendingReceipt} pending={receipt === 'sending'} reserveLabels={[m.receiptSent]} />{/if}
						</Button>
					</Field.Group>
					<p class="sr-only" role="status">{#if receipt === 'sent'}{m.receiptSentTo(sentTo)}{/if}</p>
					{#if receipt === 'invalid' || receipt === 'failed'}<Field.Error id="receipt-error">{receipt === 'invalid' ? m.receiptInvalid : m.receiptFailed}</Field.Error>{/if}
				</form>
			{/if}
			<Button variant="default" href={i18n.href('/p')}>{m.newPurchase}</Button>
		{:else if canPay && snapshot?.payment_required}
			<section class="payment grid justify-items-start gap-4" aria-labelledby="payment-heading" bind:clientHeight={paymentHeight}>
				<h2 class={sectionHeading} id="payment-heading">{m.paymentHeading}</h2>
				<p>{m.paymentInstructions}</p>
				<dl class="m-0 grid gap-3">
					<div><dt class="text-sm text-muted-foreground">{m.recipient}</dt><dd class="m-0 font-mono text-xl font-semibold">47322</dd></div>
					<div>
						<dt class="text-sm text-muted-foreground">{m.vippsMessage}</dt>
						<dd class="m-0 mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
							<span class={[codeText, 'select-all wrap-anywhere']}>{vippsMessage}</span>
							<Button variant="outline" size="sm" type="button" onclick={copyMessage}><Icon icon={messageCopied ? CheckIcon : CopyIcon} />{m.copyMessage}</Button>
						</dd>
					</div>
				</dl>
				<p class="sr-only" role="status">{#if messageCopied}{m.messageCopied}{/if}</p>
				<Button variant="default" href="https://qr.vipps.no/vp/swDrxGWcp" rel="noreferrer" disabled={refreshing} onclick={openVipps}>{m.openVipps}</Button>
				<img src="/payments/vipps-47322.svg" width="246" height="246" alt={m.qrAlt} />
				<Button variant="outline" type="button" disabled={refreshing} onclick={register}>{m.paid}</Button>
			</section>
		{:else if canPay && snapshot && !snapshot.payment_required}
			<Button variant="default" type="button" disabled={refreshing} onclick={register}>{m.free}</Button>
		{:else if canRetryConfirm}
			<Button variant="default" type="button" disabled={refreshing} onclick={register}>{m.retryConfirm}</Button>
		{:else if busy === 'confirming'}
			<Button variant="default" type="button" disabled>{m.pending}</Button>
		{:else if snapshot && !active && !$cart.activeAttempt && !busy && !error && attempt?.state === 'prepared'}
			<Button variant="outline" type="button" onclick={resume}>{m.resumeSaved}</Button>
		{/if}
	</div>
	<div class={section()}>
		<Alert.Message appearance="inline" variant="destructive">{#if error}{m.errors[error]}{/if}</Alert.Message>
		{#if error && !busy && !asideDone}
			<Button variant="outline" type="button" onclick={() => load()}>{m.retry}</Button>
		{/if}
		{#if error || (confirmationAttempted && !registered)}
			<p class="text-sm text-muted-foreground">{m.helpInstructions}</p>
		{/if}
		<p><a href={i18n.href('/contact')}>{m.help}</a></p>
		<Button variant="link" href={i18n.href('/cart')}><Icon icon={ArrowLeftIcon} />{m.backToCart}</Button>
	</div>
	{#if canPay}
		<Collapsible.Root bind:open={asideOpen} class={section()}>
			<Collapsible.Trigger>
				{#snippet child({ props })}<Button variant="outline" {...props} disabled={refreshing}>{m.setAside}</Button>{/snippet}
			</Collapsible.Trigger>
			<Collapsible.Content class="grid gap-4">
				<p>{m.setAsideQuestion}</p>
				<div class={formActions}><Button variant="outline" type="button" disabled={refreshing} onclick={setAside}>{m.setAsideConfirm}</Button><Button variant="ghost" type="button" onclick={() => { asideOpen = false; }}>{i18n.m.cart.cancel}</Button></div>
			</Collapsible.Content>
		</Collapsible.Root>
	{/if}
</div>
