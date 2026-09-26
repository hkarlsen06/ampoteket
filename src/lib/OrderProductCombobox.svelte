<script lang="ts">
	import { tick } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import type { OrderProduct } from '$lib/admin-orders';
	import * as Field from '$lib/components/ui/field';
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Button } from '$lib/components/ui/button';
	import { controlStyles } from '$lib/components/ui/control';
	import Icon from '$lib/Icon.svelte';
	import StateBadge from '$lib/StateBadge.svelte';
	import { codeText, nameWrap } from '$lib/ui';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDownIcon';

	let { id, products, value = $bindable(''), disabled = false, newProductHref, onselect }: {
		id: string; products: Omit<OrderProduct, 'purchase_url'>[]; value: string; disabled?: boolean; newProductHref?: string; onselect?: (productId: string) => void;
	} = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.adminOrders);
	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	const selected = $derived(products.find((product) => product.id === value));

	function choose(productId: string) {
		value = productId;
		onselect?.(productId);
		open = false;
		void tick().then(() => trigger?.focus());
	}
</script>

<Field.Field width="grow">
	<Field.Label for={id}>{m.product}</Field.Label>
	<Popover.Root bind:open>
		<Popover.Trigger bind:ref={trigger}>
			{#snippet child({ props })}
				<!-- Sits among form inputs, so it wears the shared control surface rather than a button's. -->
				<button {...props} {id} type="button" role="combobox" aria-expanded={open} {disabled} class={[controlStyles, 'flex min-h-12 items-center justify-between gap-2 py-2 pr-2.5 pl-3 text-left']}>
					<span class={['min-w-0', nameWrap, !selected && 'text-muted-foreground']}>{#if selected}<span class={codeText}>{selected.code}</span>: {i18n.locale === 'nb' ? selected.name_nb : selected.name_en}{:else}{m.selectProduct}{/if}</span>
					<Icon icon={CaretUpDownIcon} class="size-4 shrink-0 text-muted-foreground" />
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-(--bits-popover-anchor-width) max-w-[calc(100vw-2rem)] p-0">
			<Command.Root>
				<Command.Input placeholder={m.searchProduct} aria-label={m.searchProduct} />
				<Command.List class="overscroll-contain">
					<Command.Empty>{m.noProductMatches}</Command.Empty>
					<Command.Group>
						{#each products as product (product.id)}
							<Command.Item value={product.id} keywords={[product.code, product.name_nb, product.name_en]} data-checked={product.id === value} onSelect={() => choose(product.id)}>
								<span class={['min-w-0', nameWrap]}><span class={codeText}>{product.code}</span>: {i18n.locale === 'nb' ? product.name_nb : product.name_en}</span>
								{#if !product.is_active}<StateBadge class="shrink-0">{i18n.m.adminProducts.inactive}</StateBadge>{/if}
							</Command.Item>
						{/each}
					</Command.Group>
				</Command.List>
			</Command.Root>
		</Popover.Content>
	</Popover.Root>
	{#if newProductHref && !selected}<Button href={newProductHref} target="_blank" rel="noopener noreferrer" variant="link" class="w-fit" {disabled}>{m.newProductFromOrder}</Button>{/if}
</Field.Field>
