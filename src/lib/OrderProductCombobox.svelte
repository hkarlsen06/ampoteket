<script lang="ts">
	import { productName } from '#lib/catalog.js';
	import { tick } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import type { OrderProduct } from '#lib/admin-orders.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import AdminProductEditor from '#lib/AdminProductEditor.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { controlStyles } from '#lib/components/ui/control.js';
	import Icon from '#lib/Icon.svelte';
	import StateBadge from '#lib/StateBadge.svelte';
	import { codeText, nameWrap, sheetBody } from '#lib/ui.js';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDownIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';

	// `oncreated` adds a plus button, while no product is chosen, that creates a product in a
	// sheet; the caller adds it to `products`, and the picker then selects it.
	let { id, products, value = $bindable(''), disabled = false, oncreated, onselect, error }: {
		id: string; products: Omit<OrderProduct, 'purchase_url' | 'minimum_stock'>[]; value: string; disabled?: boolean; error?: string; onselect?: (productId: string) => void; oncreated?: (product: OrderProduct) => void;
	} = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.adminOrders);
	let open = $state(false); let creating = $state(false); let saving = $state(false); let picked = false;
	let trigger = $state<HTMLButtonElement | null>(null);
	const selected = $derived(products.find((product) => product.id === value));
	// The keyboard can cover the trigger. Keep the anchor within the visible
	// viewport so the picker can move above it instead of following it offscreen.
	const anchor = $derived(trigger ? {
		contextElement: trigger,
		getBoundingClientRect: () => {
			const rect = trigger!.getBoundingClientRect(), viewport = window.visualViewport;
			if (!viewport) return rect;
			// Convert document-relative viewport bounds to the trigger's client coordinates.
			const viewportTop = viewport.pageTop + document.documentElement.getBoundingClientRect().top;
			const top = Math.max(viewportTop, Math.min(rect.top, viewportTop + viewport.height));
			const bottom = Math.max(top, Math.min(rect.bottom, viewportTop + viewport.height));
			return new DOMRect(rect.x, top, rect.width, bottom - top);
		}
	} : null);

	function choose(productId: string) {
		value = productId;
		onselect?.(productId);
		open = false;
		void tick().then(() => trigger?.focus());
	}
	function created(product: OrderProduct) {
		oncreated?.(product);
		picked = true; creating = false;
		choose(product.id);
	}
</script>

<Field.Field width="grow">
	<Field.Label for={id}>{m.product}</Field.Label>
	<div class="flex gap-2">
	<Popover.Root bind:open>
		<Popover.Trigger bind:ref={trigger}>
			{#snippet child({ props })}
				<!-- Sits among form inputs, so it wears the shared control surface rather than a button's. -->
				<button {...props} {id} type="button" role="combobox" aria-expanded={open} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} {disabled} class={[controlStyles, 'flex min-h-12 min-w-0 flex-1 items-center justify-between gap-2 py-2 pr-2.5 pl-3 text-left']}>
					<span class={['min-w-0', nameWrap, !selected && 'text-muted-foreground']}>{#if selected}<span class={codeText}>{selected.code}</span>: {productName(selected, i18n.locale)}{:else}{m.selectProduct}{/if}</span>
					{#if selected && !selected.is_active}<StateBadge>{i18n.m.adminProducts.inactive}</StateBadge>{/if}
					<Icon icon={CaretUpDownIcon} class="size-4 shrink-0 text-muted-foreground" />
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" customAnchor={anchor} collisionPadding={8} class="w-(--bits-popover-anchor-width) max-h-(--bits-popover-content-available-height) max-w-[calc(100vw-2rem)] p-0">
			<Command.Root class="max-h-(--bits-popover-content-available-height)">
				<Command.Input placeholder={m.searchProduct} aria-label={m.searchProduct} />
				<Command.List class="min-h-0 overscroll-contain">
					<Command.Empty>{m.noProductMatches}</Command.Empty>
					<Command.Group>
						{#each products as product (product.id)}
							<Command.Item value={product.id} keywords={[product.code, product.name_nb, product.name_en]} data-checked={product.id === value} onSelect={() => choose(product.id)}>
								<span class={['min-w-0', nameWrap]}><span class={codeText}>{product.code}</span>: {productName(product, i18n.locale)}</span>
								{#if !product.is_active}<StateBadge class="shrink-0">{i18n.m.adminProducts.inactive}</StateBadge>{/if}
							</Command.Item>
						{/each}
					</Command.Group>
				</Command.List>
			</Command.Root>
		</Popover.Content>
	</Popover.Root>
	{#if oncreated && !selected}
		<Dialog.Root bind:open={creating}>
			<Dialog.Trigger {disabled}>
				{#snippet child({ props })}<Button {...props} variant="outline" size="icon" class="shrink-0"><Icon icon={PlusIcon} /><span class="sr-only">{m.newProductFromOrder}</span></Button>{/snippet}
			</Dialog.Trigger>
			<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined}
				onInteractOutside={(event) => { if (saving) event.preventDefault(); }} onEscapeKeydown={(event) => { if (saving) event.preventDefault(); }} onCloseAutoFocus={(event) => { if (picked) event.preventDefault(); picked = false; }}>
				<Dialog.Header layout="bar">
					<Dialog.Title id={`${id}-new-title`}>{i18n.m.adminProducts.newProduct}</Dialog.Title>
					<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm" disabled={saving}><Icon icon={XIcon} /><span class="sr-only">{m.closeEntry}</span></Button>{/snippet}</Dialog.Close>
				</Dialog.Header>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
				<div class={sheetBody} role="region" aria-labelledby={`${id}-new-title`} tabindex="0">
					<AdminAccessGate><AdminProductEditor id="new" oncreated={created} bind:busy={saving} /></AdminAccessGate>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	{/if}
	</div>
	{#if error}<Field.Error id={`${id}-error`}>{error}</Field.Error>{/if}
</Field.Field>
