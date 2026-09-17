<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { compareAttention, readAdminProducts, readInventory, stockRank, type AdminProduct } from '$lib/admin-products';
	import { readOutstandingByProduct } from '$lib/admin-orders';
	import { productName } from '$lib/catalog';
	import { formatDecimal, unitLabel } from '$lib/format';
	import StockBadge from '$lib/StockBadge.svelte';
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Alert from '$lib/components/ui/alert';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Separator } from '$lib/components/ui/separator';
	import { codeText, nameWrap, sheetBody } from '$lib/ui';
	import { Skeleton } from '$lib/components/ui/skeleton';

	// Picks every active part that is sold out or below its minimum (not just the overview's
	// most urgent few) and opens the New order form with those products as lines.
	type Row = { product: AdminProduct; quantity: string; unit: string; outstanding: string | null };
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminStatistics); const id = $props.id();
	let open = $state(false); let rows = $state<Row[] | null>(null); let selected = $state(new Set<string>());
	let loading = $state(false); let failed = $state(false); let trigger = $state<HTMLButtonElement | null>(null); let generation = 0;
	const all = $derived(Boolean(rows?.length) && selected.size === rows!.length);
	onMount(() => () => { generation++; });

	async function load() {
		const version = ++generation; loading = true; failed = false; const session = admin.credentials();
		try {
			const [products, inventory, outstanding] = await Promise.all([readAdminProducts(session), readInventory(session), readOutstandingByProduct(session)]);
			if (version !== generation || session.userId !== admin.session?.user.id) return;
			const stock = new Map(inventory.map(item => [item.product_id, item.quantity]));
			rows = products.filter(p => stockRank(p, stock.get(p.id)) < 2)
				.sort((a, b) => compareAttention(a, stock.get(a.id), b, stock.get(b.id)) || a.code.localeCompare(b.code))
				.map(product => ({ product, quantity: stock.get(product.id)!, unit: unitLabel(product.unit_code, i18n.locale), outstanding: outstanding.get(product.id) ?? null }));
			// Parts already on order start unchecked so they are not ordered twice.
			selected = new Set(rows.filter(row => !row.outstanding).map(row => row.product.id));
		} catch (error) { if (version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (version === generation) loading = false; }
	}
	function show() { open = true; rows = null; void load(); }
	function choose(productId: string, checked: boolean) {
		selected = checked ? new Set([...selected, productId]) : new Set([...selected].filter((id) => id !== productId));
	}
	function start() {
		const ids = rows!.filter(row => selected.has(row.product.id)).map(row => row.product.id);
		void goto(i18n.href(`/admin/orders?new=${ids.join(',')}`));
	}
</script>

<Button bind:ref={trigger} type="button" aria-haspopup="dialog" onclick={show}>{m.openOrder}</Button>
<Dialog.Root bind:open>
	<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined}
		onCloseAutoFocus={(event) => { event.preventDefault(); void tick().then(() => trigger?.focus({ preventScroll: true })); }}>
		<Dialog.Header layout="bar">
			<Dialog.Title id={`${id}-title`}>{m.orderHeading}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} /><span class="sr-only">{m.closeOrder}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
		<div class={sheetBody} role="region" aria-labelledby={`${id}-title`} tabindex="0">
			{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load} disabled={loading}>{m.retry}</Button>
			{:else if !rows}<span class="sr-only" role="status">{m.loading}</span><div class="space-y-4" aria-hidden="true"><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /></div>
			{:else if !rows.length}<Empty.Root><Empty.Description>{m.noAttention}</Empty.Description></Empty.Root>
			{:else}
				<Field.Field orientation="horizontal" class="gap-3 pb-4">
					<Checkbox id={`${id}-all`} checked={all} indeterminate={!all && selected.size > 0} onCheckedChange={(checked) => { selected = new Set(checked === true ? rows!.map(row => row.product.id) : []); }} />
					<Field.Label for={`${id}-all`} class="cursor-pointer">{m.selectAll}</Field.Label>
				</Field.Field>
				{#each rows as row (row.product.id)}
					<Separator />
					<Field.Field orientation="horizontal" class="min-w-0 gap-3 py-4">
						<Checkbox id={`${id}-${row.product.id}`} checked={selected.has(row.product.id)} onCheckedChange={(checked) => choose(row.product.id, checked === true)} />
						<div class="min-w-0">
							<Field.Label for={`${id}-${row.product.id}`} class={['cursor-pointer', nameWrap]}>{productName(row.product, i18n.locale)}</Field.Label>
							<Field.Description class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
								<span class={codeText}>{row.product.code}</span>
								<StockBadge quantity={row.quantity} unit={row.unit} minimum={row.product.minimum_stock} compact />
								{#if row.outstanding}<Badge variant="outline">{m.onOrder(`${formatDecimal(row.outstanding, i18n.locale)} ${unitLabel(row.unit, i18n.locale, row.outstanding)}`)}</Badge>{/if}
							</Field.Description>
						</div>
					</Field.Field>
				{/each}
			{/if}
		</div>
		{#if rows?.length}
			<Dialog.Footer variant="sheet">
				<Button type="button" disabled={!selected.size} onclick={start}>{m.startOrder(selected.size)}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
