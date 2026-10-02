<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { CartError, getCartContext, type CartLine, type CartErrorCode } from '#lib/cart.js';
	import { productName } from '#lib/catalog.js';
	import type { CartProductFact } from '#lib/cart-catalog.js';
	import { formatDecimal, formatMeasurementText, formatMoney, unitLabel } from '#lib/format.js';
	import { addDecimals, lineTotal, normalizeDecimal, validQuantity } from '#lib/decimal.js';
	import ProductIdentity from '#lib/ProductIdentity.svelte';
	import ProductAvailability from '#lib/ProductAvailability.svelte';
	import QuantityStepper from '#lib/QuantityStepper.svelte';
	import { codeText, nameWrap } from '#lib/ui.js';

	let { line, fact, locked, onremoved, onready, onretry }: { line: CartLine; fact?: CartProductFact; locked: boolean; onremoved: (returnFocus: boolean) => void; onready?: (ready: boolean) => void; onretry?: () => void } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.cart);
	const cart = getCartContext();
	const product = $derived(fact && 'product' in fact ? fact.product ?? null : null);
	const name = $derived(product ? productName(product, i18n.locale)
		: formatMeasurementText((i18n.locale === 'nb' ? line.name_nb ?? line.name_en : line.name_en ?? line.name_nb) ?? line.code ?? m.unknown, i18n.locale));
	const total = $derived.by(() => {
		if (!product) return null;
		try { return lineTotal(line.quantity, product.sale_unit_price_nok); } catch { return null; }
	});
	let draft = $state('');
	let baseline = $state('');
	let draftLocale = $state<string | null>(null);
	let dirty = $state(false);
	let pending = $state(false);
	let removing = $state(false);
	let result = $state(false);
	let error = $state<CartErrorCode | null>(null);
	const displayError = $derived.by(() => {
		if (error || dirty || fact?.kind !== 'ready') return error;
		try { validQuantity(line.quantity, fact.product.sale_step); return null; }
		catch { return 'quantity'; }
	});
	const notice = $derived(!!displayError || (!!fact && fact.kind !== 'ready'));
	let stepper: QuantityStepper | undefined = $state();
	let revision = 0;
	let saving: Promise<boolean> | null = null;
	$effect(() => {
		let ready = fact?.kind === 'ready' && !dirty && !pending && !removing && !displayError;
		if (product) { try { validQuantity(line.quantity, product.sale_step); } catch { ready = false; } }
		untrack(() => onready?.(ready));
	});
	$effect(() => {
		// Preserve typing such as a trailing decimal separator after our own save.
		const locale = i18n.locale;
		if (!dirty && (baseline !== line.quantity || draftLocale !== locale)) {
			draft = normalizeDecimal(line.quantity).replace('.', locale === 'nb' ? ',' : '.');
			baseline = line.quantity;
			draftLocale = locale;
		}
	});
	function save(reportInvalid = false): Promise<boolean> {
		if (!product || fact?.kind !== 'ready' || locked || removing) return Promise.resolve(false);
		if (reportInvalid) {
			try { validQuantity(draft, product.sale_step, i18n.locale); }
			catch { error = 'quantity'; return Promise.resolve(false); }
		}
		if (saving) return saving;
		saving = persist(product.sale_step).finally(() => { saving = null; });
		return saving;
	}
	async function persist(saleStep: string): Promise<boolean> {
		pending = true;
		try {
			// Coalesce edits made while waiting for the shared cart lock. Each write
			// still compares against the last quantity we successfully persisted.
			while (dirty && fact?.kind === 'ready' && !locked && !removing) {
				let quantity: string;
				try { quantity = validQuantity(draft, saleStep, i18n.locale); }
				catch { break; }
				const currentRevision = revision;
				await cart.setQuantity(line.product_id, quantity, saleStep, i18n.locale, baseline);
				baseline = quantity;
				if (revision === currentRevision) { dirty = false; result = true; }
			}
			return true;
		} catch (failure) {
			error = failure instanceof CartError ? failure.code : 'storage';
			if (error === 'changed') { dirty = false; baseline = ''; }
			return false;
		} finally { pending = false; }
	}
	function edit(value: string) {
		draft = value; dirty = true; revision += 1; result = false; error = null;
		void save();
	}
	function step(direction: 1 | -1) {
		if (!product || fact?.kind !== 'ready' || locked || removing) return;
		error = null; result = false;
		try {
			const current = validQuantity(draft, product.sale_step, i18n.locale);
			const next = validQuantity(addDecimals(current, direction === 1 ? product.sale_step : `-${product.sale_step}`), product.sale_step);
			edit(next.replace('.', i18n.locale === 'nb' ? ',' : '.'));
		} catch { error = 'quantity'; stepper?.focus(); }
	}
	async function remove() {
		if (locked || removing) return;
		const returnFocus = document.activeElement?.matches(':focus-visible') ?? false;
		removing = true; result = false; error = null;
		try {
			// Finish an in-flight write before removing; never replay a queued edit
			// after removal or bypass a conflict detected by that write.
			if (saving && !await saving) return;
			if (locked) return;
			await cart.remove(line.product_id, baseline); onremoved(returnFocus);
		}
		catch (failure) {
			error = failure instanceof CartError ? failure.code : 'storage';
			if (error === 'changed') { dirty = false; baseline = ''; }
		} finally { removing = false; }
	}
</script>

<li class="cart-line">
	<Item.Root variant="outline" class="grid gap-0 bg-card p-5 text-card-foreground">
		<div class="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_16rem] md:gap-x-6">
			<Item.Content class="min-w-0 gap-0">
				{#if product}
					<ProductIdentity {product} />
				{:else}
					<!-- Same scale as ProductIdentity, so rows do not change size when facts load. -->
					<h2 class={['m-0 text-lg font-semibold leading-snug', nameWrap]}>{name}</h2>
					{#if line.code}<p class={[codeText, 'mt-1 text-muted-foreground']}>{line.code}</p>{/if}
				{/if}
				<div class="mt-2 flex min-h-11 flex-wrap content-start items-baseline gap-x-4 gap-y-2 md:min-h-6">
					{#if product}
						<ProductAvailability {product} plain />
					{:else if !fact}
						<Skeleton class="h-6 w-40" aria-hidden="true" />
					{/if}
				</div>
			</Item.Content>
			<form class="grid min-w-0 content-start gap-2" onsubmit={(event) => { event.preventDefault(); void save(true); if (error === 'quantity') stepper?.focus(); }} novalidate>
				<Field.Label class="sr-only" for={`quantity-${line.product_id}`}>{m.quantity}{#if unitLabel(product?.unit_symbol, i18n.locale) ?? unitLabel(line.unit_symbol, i18n.locale)} ({unitLabel(product?.unit_symbol, i18n.locale) ?? unitLabel(line.unit_symbol, i18n.locale)}){/if}</Field.Label>
				<Item.Actions class="flex-wrap gap-2">
					<div class="min-w-0 flex-[1_1_8rem]">
						<QuantityStepper
							bind:this={stepper}
							bind:value={draft}
							id={`quantity-${line.product_id}`}
							disabled={locked || removing || !product}
							invalid={displayError === 'quantity'}
							describedby={`step-${line.product_id} result-${line.product_id}`}
							decreaseLabel={m.decrease(name)}
							increaseLabel={m.increase(name)}
							onstep={step}
							oninput={edit}
							onblur={() => { void save(true); }}
						/>
					</div>
					<Button variant="ghost" class="remove shrink-0 text-muted-foreground hover:text-destructive" size="icon" type="button" aria-label={m.removeFor(name)} onclick={remove} disabled={locked || removing}>
						<Icon icon={TrashIcon} />
					</Button>
				</Item.Actions>
				<p class="min-h-6 text-right font-mono text-base font-semibold tabular-nums">{#if total !== null}<span class="sr-only">{m.lineTotal} </span>{formatMoney(total, i18n.locale)}{/if}</p>
			</form>
		</div>
		<Item.Footer class={['flex-wrap items-baseline gap-x-4 gap-y-1', notice && 'mt-2']}>
			<p class="sr-only" id={`step-${line.product_id}`}>{#if product}{m.step(formatDecimal(product.sale_step, i18n.locale), unitLabel(product.unit_symbol, i18n.locale, product.sale_step))}{/if}</p>
			<div class={['min-w-0 text-sm', !notice && 'sr-only']} id={`result-${line.product_id}`} role={displayError ? 'alert' : 'status'}>
				{#if displayError}<Field.Error role={undefined}>{m.errors[displayError]}{#if displayError === 'quantity' && product} {m.step(formatDecimal(product.sale_step, i18n.locale), unitLabel(product.unit_symbol, i18n.locale, product.sale_step))}{/if}</Field.Error>
				{:else if fact?.kind === 'unavailable'}<Alert.Message role={undefined} appearance="inline" variant="destructive">{m.factsUnavailable}</Alert.Message>
				{:else if fact?.kind === 'missing'}<Field.Description>{m.missing}</Field.Description>
				{:else if !product}{m.factsLoading}
				{:else if pending}{m.saving}
				{:else if result}{m.saved}{/if}
			</div>
			{#if !displayError && fact?.kind === 'unavailable' && onretry}
				<div class="basis-full"><Button variant="outline" type="button" onclick={onretry}>{m.retry}</Button></div>
			{/if}
		</Item.Footer>
	</Item.Root>
</li>
