<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { normalizeDecimal, validQuantity } from '$lib/decimal';
	import { osloInstant, osloLocal, possibleOsloOffsets } from '$lib/oslo-time';
	import { formatCountedAt, formatDecimal, unitLabel } from '$lib/format';
	import { clearOrderCommand, orderCommandPath, orderRejection, orderStorageEvent, readOrderCommand, readOrderProducts, readOrders, readUnplannedReceipts, runOrderCommand, saveOrderCommand, updateOrderStorage, type Order, type OrderCommand, type OrderProduct, type OrderReceipt } from '$lib/admin-orders';
	import { codeText, formActions, formLayout, formStatus, itemTitle, nameWrap, pageHeader, pageHeading, section, sectionHeading, sheetBody } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as Item from '$lib/components/ui/item';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Separator } from '$lib/components/ui/separator';
	import OrderProductCombobox from '$lib/OrderProductCombobox.svelte';
	import AdminOrderReceipt from '$lib/AdminOrderReceipt.svelte';

	type DraftLine = { key: string; productId: string; quantity: string; unitCost: string; purchaseUrl: string; supplierSku: string };
	const blankLine = (): DraftLine => ({ key: crypto.randomUUID(), productId: '', quantity: '', unitCost: '', purchaseUrl: '', supplierSku: '' });
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminOrders);
	let orders = $state<Order[]>([]); let products = $state<OrderProduct[]>([]); let unplanned = $state<OrderReceipt[]>([]);
	let loaded = $state(false); let loading = $state(true); let failed = $state(false); let busy = $state(false); let storageReady = $state(false);
	let mode = $state<'closed' | 'create' | 'receipt'>('closed'); let command = $state<OrderCommand | null>(null);
	let outcome = $state<'idle' | 'invalid' | 'date' | 'ambiguous' | 'conflict' | 'unknown' | 'recorded'>('idle');
	let supplier = $state(''); let reference = $state(''); let placedLocal = $state(''); let offset = $state(''); let additionalCost = $state('0'); let note = $state('');
	let sourceNote = $state(''); let lines = $state<DraftLine[]>([]); let mounted = false; let generation = 0;
	let newOrderTrigger = $state<HTMLButtonElement | null>(null);
	let receiptTrigger = $state<HTMLButtonElement | null>(null);
	let returnMode: 'create' | 'receipt' = 'create';
	let selectedOrderId = $state<string | null>(null);
	let orderReceiptTrigger = $state<HTMLElement | null>(null);
	let plannedRecorded = $state(false);
	// Product IDs chosen from the overview's "Needs attention" sheet; each becomes a line once products load.
	let prefill: string[] | null = page.url.searchParams.get('new')?.split(',').filter(Boolean) ?? null;
	// An untouched placement time follows the clock until saving, since the admin shops before recording.
	let placedEdited = false;
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const otherCommand = $derived(Boolean(command && (command.kind !== 'create' && (command.kind !== 'receipt' || command.orderId !== null))));
	const frozen = $derived(Boolean(command));
	const offsets = $derived(possibleOsloOffsets(placedLocal));
	// A pending command elsewhere: a planned receipt reopens its sheet here, anything else links to its page.
	const pendingNotice = $derived(!storageReady || wrongIdentity || selectedOrderId ? null : command?.kind === 'receipt' && command.orderId ? 'planned' : otherCommand ? 'other' : null);

	function placedInstant(): string {
		let value: string;
		try { value = osloInstant(placedLocal, offsets.length === 2 ? offset : ''); }
		catch (error) { throw new Error(error instanceof Error && error.message === 'AMBIGUOUS_OSLO_TIME' ? 'ambiguous' : 'date', { cause: error }); }
		if (new Date(value).valueOf() > Date.now() + 86_400_000) throw new Error('date');
		return value;
	}
	function cost(input: string, scale: number): string {
		const value = normalizeDecimal(input, i18n.locale);
		if (!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${scale}})?$`).test(value)) throw new Error('invalid');
		return value;
	}
	function product(id: string): OrderProduct {
		const found = products.find((value) => value.id === id);
		if (!found) throw new Error('invalid');
		return found;
	}
	function purchaseUrl(input: string): string | null {
		const value = input.trim();
		if (!value) return null;
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(value)) throw new Error('invalid');
		return value;
	}
	function openable(input: string): boolean { try { return purchaseUrl(input) !== null; } catch { return false; } }
	function draftCommand(): OrderCommand {
		if (!lines.length || lines.length > 200) throw new Error('invalid');
		const session = admin.credentials();
		const items = lines.map((line) => {
			const selected = product(line.productId);
			const quantity = validQuantity(line.quantity, selected.stock_step, i18n.locale);
			return { productId: selected.id, quantity, unitCostNok: mode === 'create' ? cost(line.unitCost, 6) : '0',
				purchaseUrl: mode === 'create' ? purchaseUrl(line.purchaseUrl) : null, supplierSku: line.supplierSku.trim() || null, orderLineId: null };
		});
		if (mode === 'create') {
			if (!supplier.trim() || [...supplier.trim()].length > 200) throw new Error('invalid');
			return { kind: 'create', userId: session.userId, requestId: crypto.randomUUID(), supplierName: supplier.trim(), placedAt: placedInstant(),
				additionalCostNok: cost(additionalCost, 2), supplierReference: reference.trim() || null, note: note.trim() || null,
				items: items.map(({ productId, quantity, unitCostNok, purchaseUrl, supplierSku }) => ({ productId, quantity, unitCostNok, purchaseUrl, supplierSku })) };
		}
		if (!sourceNote.trim()) throw new Error('invalid');
		return { kind: 'receipt', userId: session.userId, requestId: crypto.randomUUID(), orderId: null, note: sourceNote.trim(), occurredAt: null,
			items: items.map(({ productId, quantity, orderLineId }) => ({ productId, quantity, orderLineId })) };
	}
	function syncPending() {
		if (busy) return;
		try {
			command = readOrderCommand(localStorage);
			if (command?.kind === 'create') {
				const pending = command;
				returnMode = 'create';
				mode = 'create'; supplier = pending.supplierName; reference = pending.supplierReference ?? ''; additionalCost = pending.additionalCostNok; note = pending.note ?? '';
				placedLocal = osloLocal(new Date(pending.placedAt)); offset = possibleOsloOffsets(placedLocal).find((value) => new Date(`${placedLocal}:00${value}`).toISOString() === pending.placedAt) ?? '';
				lines = pending.items.map((item) => ({ key: crypto.randomUUID(), productId: item.productId, quantity: item.quantity, unitCost: item.unitCostNok, purchaseUrl: item.purchaseUrl ?? '', supplierSku: item.supplierSku ?? '' }));
				outcome = 'unknown';
			} else if (command?.kind === 'receipt' && !command.orderId) {
				returnMode = 'receipt';
				mode = 'receipt'; sourceNote = command.note ?? '';
				lines = command.items.map((item) => ({ key: crypto.randomUUID(), productId: item.productId, quantity: item.quantity, unitCost: '', purchaseUrl: '', supplierSku: '' }));
				outcome = 'unknown';
			} else if (command?.kind === 'receipt' && command.orderId) {
				selectedOrderId = command.orderId;
			}
		} catch { storageReady = false; }
	}
	onMount(() => {
		mounted = true; placedLocal = osloLocal(new Date()); lines = [blankLine()]; syncPending();
		void updateOrderStorage((storage) => { readOrderCommand(storage); const key = 'ampoteket:order-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); }).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(orderStorageEvent, syncPending); void load();
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(orderStorageEvent, syncPending); };
	});
	async function load() {
		const version = ++generation; loading = true; failed = false; const session = admin.credentials();
		try {
			const [orderRows, productRows, receiptRows] = await Promise.all([readOrders(session), readOrderProducts(session), readUnplannedReceipts(session)]);
			if (mounted && version === generation && session.userId === admin.session?.user.id) {
				orders = orderRows; products = productRows; unplanned = receiptRows; loaded = true;
				if (prefill && !command) {
					const chosen = prefill.flatMap((id) => productRows.filter((item) => item.id === id));
					if (chosen.length) { lines = chosen.map((item) => ({ ...blankLine(), productId: item.id, purchaseUrl: item.purchase_url ?? '' })); show('create'); }
				}
				prefill = null;
			}
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	function revalidate() { if (admin.status === 'ready' && document.visibilityState === 'visible' && !loading) void load(); }
	function show(next: 'create' | 'receipt') {
		if (command) return; returnMode = next; mode = next; outcome = 'idle';
		if (!lines.length) lines = [blankLine()];
	}
	function closeForm() {
		if (busy || (command && !wrongIdentity)) return;
		if (mode !== 'closed') returnMode = mode;
		mode = 'closed';
		if (page.url.searchParams.has('new')) replaceState(i18n.href('/admin/orders'), {});
	}
	function resumePlanned() {
		if (command?.kind === 'receipt' && command.orderId) selectedOrderId = command.orderId;
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !storageReady || wrongIdentity || otherCommand || mode === 'closed' || !loaded || failed || (command && command.kind !== mode)) return;
		if (mode === 'create' && !command && !placedEdited) { placedLocal = osloLocal(new Date()); offset = ''; }
		let candidate: OrderCommand;
		try { candidate = command ?? draftCommand(); }
		catch (error) { outcome = error instanceof Error && error.message === 'date' ? 'date' : error instanceof Error && error.message === 'ambiguous' ? 'ambiguous' : 'invalid'; return; }
		busy = true; outcome = 'idle'; const session = admin.credentials(); let saved: OrderCommand | null = null;
		try {
			saved = await updateOrderStorage((storage) => saveOrderCommand(storage, candidate)); command = saved;
			const result = await runOrderCommand(session, saved);
			await updateOrderStorage((storage) => clearOrderCommand(storage, saved!));
			if (!mounted || session.userId !== admin.session?.user.id) return;
			command = null; outcome = 'recorded';
			if (result.kind === 'create') await goto(i18n.href(`/admin/orders/${result.orderId}`));
			else { sourceNote = ''; lines = [blankLine()]; mode = 'closed'; await load(); }
		} catch (error) {
			const rejected = saved ? orderRejection(error) : null;
			if (rejected && saved) {
				try { await updateOrderStorage((storage) => clearOrderCommand(storage, saved!)); command = null; outcome = rejected === 'stale' ? 'conflict' : 'invalid'; }
				catch { outcome = 'unknown'; }
			} else outcome = saved ? 'unknown' : 'invalid';
			await admin.permissionFailure(error);
		} finally { if (mounted) { busy = false; syncPending(); } }
	}
</script>

<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<div class={formActions}>
		<Button bind:ref={newOrderTrigger} type="button" variant="default" aria-haspopup="dialog" onclick={() => show('create')} disabled={Boolean(command)}>{m.newOrder}</Button>
		<Button bind:ref={receiptTrigger} type="button" variant="outline" aria-haspopup="dialog" onclick={() => show('receipt')} disabled={Boolean(command)}>{m.unplannedReceipt}</Button>
	</div>
</header>
{#snippet entryStatus()}
<div class={formStatus} aria-live="polite">
	{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
	{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
	{:else if pendingNotice}<Alert.Message appearance="inline" role="status">{m.pendingElsewhere}</Alert.Message>
	{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknown}</Alert.Message>
	{:else if outcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.conflict}</Alert.Message>
	{:else if outcome === 'date'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalidDate}</Alert.Message>
	{:else if outcome === 'ambiguous'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.ambiguousDate}</Alert.Message>
	{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalid}</Alert.Message>
	{:else if outcome === 'recorded' || plannedRecorded}<Alert.Message appearance="inline" role="status">{m.receiptRecorded}</Alert.Message>{/if}
	{#if failed && mode !== 'closed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}
</div>
{#if pendingNotice === 'planned'}<Button type="button" variant="link" onclick={resumePlanned}>{m.resumePending}</Button>
{:else if pendingNotice === 'other' && command}<Button variant="link" href={i18n.href(orderCommandPath(command))}>{m.resumePending}</Button>{/if}
{#if failed && mode !== 'closed'}<Button type="button" variant="outline" disabled={loading} onclick={load}>{m.retry}</Button>{/if}
{/snippet}
{#if mode === 'closed'}{@render entryStatus()}{/if}
<Dialog.Root open={mode !== 'closed'} onOpenChange={(open) => { if (!open) closeForm(); }}>
	<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined}
		onInteractOutside={(event) => { if (busy || (command && !wrongIdentity)) event.preventDefault(); }}
		onEscapeKeydown={(event) => { if (busy || (command && !wrongIdentity)) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { event.preventDefault(); void tick().then(() => (returnMode === 'create' ? newOrderTrigger : receiptTrigger)?.focus({ preventScroll: true })); }}>
		<Dialog.Header layout="bar">
			<Dialog.Title id="order-entry-title">{mode === 'create' ? m.newOrder : m.unplannedReceipt}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm" disabled={busy || Boolean(command && !wrongIdentity)}><Icon icon={XIcon} /><span class="sr-only">{m.closeEntry}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
		<div class={['order-entry-body', sheetBody]} role="region" aria-labelledby="order-entry-title" tabindex="0">
			{#if mode !== 'closed'}{@render entryStatus()}{/if}
			<form id={`${fieldId}-order-form`} class={formLayout} onsubmit={submit}>
			{#if mode === 'create'}
				<Field.Group layout="row">
					<Field.Field width="grow"><Field.Label for={`${fieldId}-supplier`}>{m.supplier}</Field.Label><Input id={`${fieldId}-supplier`} required maxlength={200} bind:value={supplier} disabled={frozen || busy} /></Field.Field>
					<Field.Field width="medium"><Field.Label for={`${fieldId}-reference`}>{m.reference}</Field.Label><Input id={`${fieldId}-reference`} maxlength={2000} bind:value={reference} disabled={frozen || busy} /></Field.Field>
				</Field.Group>
				<Field.Group layout="row">
					<Field.Field width="medium"><Field.Label for={`${fieldId}-placed`}>{m.placedAt}</Field.Label><Input id={`${fieldId}-placed`} type="datetime-local" required bind:value={placedLocal} oninput={() => { offset = ''; placedEdited = true; }} disabled={frozen || busy} /></Field.Field>
						{#if offsets.length === 2}<Field.Field width="medium"><Field.Label for={`${fieldId}-offset`}>{m.offset}</Field.Label><NativeSelect.Root id={`${fieldId}-offset`} required bind:value={offset} onchange={() => { placedEdited = true; }} disabled={frozen || busy}><NativeSelect.Option value="">{m.chooseOffset}</NativeSelect.Option><NativeSelect.Option value="+02:00">{m.beforeClockChange}</NativeSelect.Option><NativeSelect.Option value="+01:00">{m.afterClockChange}</NativeSelect.Option></NativeSelect.Root></Field.Field>{/if}
					<Field.Field width="medium"><Field.Label for={`${fieldId}-extra`}>{m.additionalCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-extra`} type="text" inputmode="decimal" required bind:value={additionalCost} disabled={frozen || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root></Field.Field>
				</Field.Group>
				<Field.Field><Field.Label for={`${fieldId}-note`}>{m.note}</Field.Label><Textarea id={`${fieldId}-note`} rows={2} maxlength={2000} bind:value={note} disabled={frozen || busy} /></Field.Field>
			{:else}
				<Field.Field><Field.Label for={`${fieldId}-source`}>{m.sourceNote}</Field.Label><Textarea id={`${fieldId}-source`} rows={2} required maxlength={2000} bind:value={sourceNote} disabled={frozen || busy} /></Field.Field>
			{/if}
			<div class="space-y-6">
				{#each lines as line, index (line.key)}
					{@const unit = unitLabel(products.find((item) => item.id === line.productId)?.unit_code, i18n.locale)}
					<fieldset class="space-y-3">
						<legend id={`${fieldId}-line-${line.key}`} class="font-semibold">{m.lineNumber(index + 1)}</legend>
						<Separator />
						<Field.Group layout="row">
							<OrderProductCombobox id={`${fieldId}-product-${line.key}`} {products} bind:value={line.productId} newProductHref={mode === 'create' ? i18n.href('/admin/products/new') : undefined} disabled={frozen || busy || loading} />
							<Field.Field width="short"><Field.Label for={`${fieldId}-qty-${line.key}`}>{m.quantity}{#if unit}<span class="sr-only">{` (${unit})`}</span>{/if}</Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-qty-${line.key}`} type="text" inputmode="decimal" required bind:value={line.quantity} disabled={frozen || busy} />{#if unit}<InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unit}</InputGroup.Text></InputGroup.Addon>{/if}</InputGroup.Root></Field.Field>
							{#if mode === 'create'}<Field.Field width="medium"><Field.Label for={`${fieldId}-cost-${line.key}`}>{m.unitCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-cost-${line.key}`} type="text" inputmode="decimal" required bind:value={line.unitCost} disabled={frozen || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root></Field.Field>{/if}
						</Field.Group>
						{#if mode === 'create'}<Field.Group layout="row"><Field.Field width="grow"><Field.Label for={`${fieldId}-url-${line.key}`}>{m.purchaseUrl}</Field.Label><Input id={`${fieldId}-url-${line.key}`} type="url" maxlength={2000} bind:value={line.purchaseUrl} disabled={frozen || busy} />{#if openable(line.purchaseUrl)}<a class="w-fit text-sm" href={line.purchaseUrl.trim()} target="_blank" rel="noopener noreferrer" aria-describedby={`${fieldId}-line-${line.key}`}>{m.openPurchaseUrl}</a>{/if}</Field.Field><Field.Field width="medium"><Field.Label for={`${fieldId}-sku-${line.key}`}>{m.supplierSku}</Field.Label><Input id={`${fieldId}-sku-${line.key}`} maxlength={2000} bind:value={line.supplierSku} disabled={frozen || busy} /></Field.Field></Field.Group>{/if}
						{#if lines.length > 1 && !frozen}<Button type="button" variant="ghost" onclick={() => lines = lines.filter((item) => item.key !== line.key)} disabled={busy}>{m.removeLine}</Button>{/if}
					</fieldset>
				{/each}
			</div>
				<div><Button type="button" variant="outline" onclick={() => lines = [...lines, blankLine()]} disabled={frozen || busy || lines.length >= 200}>{m.addLine}</Button></div>
			</form>
		</div>
		<Dialog.Footer variant="sheet">
			<Button type="submit" form={`${fieldId}-order-form`} disabled={!storageReady || !loaded || failed || busy || wrongIdentity || otherCommand}><ButtonLabel pending={busy} pendingLabel={m.working} label={frozen ? m.retrySame : mode === 'create' ? m.recordOrder : m.recordReceipt} reserveLabels={[m.retrySame, m.recordOrder, m.recordReceipt]} /></Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
{#if selectedOrderId}<AdminOrderReceipt orderId={selectedOrderId} returnFocus={orderReceiptTrigger} onclose={() => { selectedOrderId = null; }} onrecorded={async () => { plannedRecorded = true; await load(); }} />{/if}
<section class={section({ spacing: 'divided' })} aria-labelledby="orders-heading">
	<Separator />
	<h2 class={sectionHeading} id="orders-heading">{m.orders}</h2>
	{#if failed && mode === 'closed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" disabled={loading} onclick={load}>{m.retry}</Button>{/if}
	{#if loading && !loaded}<span class="sr-only" role="status">{m.loading}</span><div class="min-h-64 space-y-6" aria-hidden="true" aria-busy="true">{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}</div>{/if}
	{#if loaded}
		{#if !orders.length}<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>{:else}
			<Item.Group>{#each orders as order, index (order.id)}{#if index > 0}<Item.Separator />{/if}<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0 basis-72"><Item.Title class={itemTitle}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/orders/${order.id}`)}>{order.supplierName}</a></Item.Title><Item.Description>{formatCountedAt(order.placedAt, i18n.locale)}{order.supplierReference ? ` · ${order.supplierReference}` : ''} · {m.openLines(order.openLineCount)}</Item.Description></Item.Content><Item.Actions><Button type="button" variant="outline" size="sm" aria-haspopup="dialog" disabled={Boolean(command && (command.kind !== 'receipt' || command.orderId !== order.id))} onclick={(event) => { orderReceiptTrigger = event.currentTarget; selectedOrderId = order.id; plannedRecorded = false; }}>{m.openReceipt}</Button></Item.Actions></Item.Root>{/each}</Item.Group>
		{/if}
	{/if}
</section>
<!-- Receipts without an order appear once there are any; the orders read above owns loading and failure. -->
{#if loaded && unplanned.length}
<section class={section({ spacing: 'divided' })} aria-labelledby="unplanned-heading">
	<Separator />
	<h2 class={sectionHeading} id="unplanned-heading">{m.unplannedHistory}</h2>
	<Item.Group>{#each unplanned as receipt, index (receipt.id)}{#if index > 0}<Item.Separator />{/if}<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0"><Item.Title class={itemTitle}>{receipt.note ?? m.unplannedHistory}</Item.Title><Item.Description>{formatCountedAt(receipt.occurredAt, i18n.locale)}</Item.Description><ul class="space-y-1 text-sm">{#each receipt.movements as movement (movement.id)}{@const product = products.find((item) => item.id === movement.productId)}<li class={nameWrap}>{#if product}<span class={codeText}>{product.code}</span> {i18n.locale === 'nb' ? product.name_nb : product.name_en}{:else}{movement.productId}{/if} · <span class="font-mono">{formatDecimal(movement.quantityDelta, i18n.locale)} {unitLabel(product?.unit_code, i18n.locale, movement.quantityDelta)}</span></li>{/each}</ul></Item.Content></Item.Root>{/each}</Item.Group>
</section>
{/if}
