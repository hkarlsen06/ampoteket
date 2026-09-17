<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { ApiError, uuidPattern } from '$lib/api';
	import { compareDecimals, normalizeDecimal, validQuantity } from '$lib/decimal';
	import { formatCountedAt, formatDecimal, formatMoney, unitLabel } from '$lib/format';
	import { osloInstant, osloLocal, possibleOsloOffsets } from '$lib/oslo-time';
	import { staffEquals, staffRequest } from '$lib/admin-api';
	import AdminOrderReceipt from '$lib/AdminOrderReceipt.svelte';
	import { clearOrderCommand, orderCommandPath, orderRejection, orderStorageEvent, readOrderCommand, readOrderDetail, runOrderCommand, saveOrderCommand, updateOrderStorage, type Order, type OrderCommand, type OrderDetail, type OrderLine } from '$lib/admin-orders';
	import { codeText, formLayout, formStatus, itemTitle, nameWrap, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import DisclosureTrigger from '$lib/DisclosureTrigger.svelte';
	import * as Field from '$lib/components/ui/field';
	import * as Item from '$lib/components/ui/item';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';

	const i18n = getI18n();
	const admin = getAdminContext();
	const m = $derived(i18n.m.adminOrders);
	const fieldId = $props.id();
	let detail = $state<OrderDetail | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let busy = $state(false);
	let sendingCommand = false;
	let storageReady = $state(false);
	let command = $state<OrderCommand | null>(null);
	let cancellationQuantities = $state<Record<string, string>>({});
	let cancellationReason = $state('');
	let reversalReason = $state('');
	let reversingId = $state<string | null>(null);
	let outcome = $state<'idle' | 'saved' | 'unknown' | 'invalid' | 'conflict'>('idle');
	let savedAction = $state<'receipt' | 'cancel' | 'reverse' | null>(null);
	let editingHeader = $state(false);
	let editingLineId = $state<string | null>(null);
	let headerBasis = $state<Order | null>(null);
	let lineBasis = $state<OrderLine | null>(null);
	let headerDraft = $state({ supplierName: '', supplierReference: '', placedAt: '', offset: '', additionalCostNok: '', note: '' });
	let lineDraft = $state({ unitCostNok: '', purchaseUrl: '', supplierSku: '' });
	let metadataOutcome = $state<'idle' | 'saved' | 'unknown' | 'invalid' | 'conflict'>('idle');
	let receiptOpen = $state(page.url.searchParams.has('receive'));
	let receiptTrigger = $state<HTMLButtonElement | null>(null);
	let cancelConfirmOpen = $state(false);
	let cancelTrigger = $state<HTMLButtonElement | null>(null);
	let mounted = false;
	let generation = 0;
	let displayedId = '';
	const order = $derived(detail?.order && detail.order.id === page.params.id ? detail.order : null);
	const products = $derived(new Map(detail?.products.map((product) => [product.id, product]) ?? []));
	const actors = $derived(new Map(detail?.actors.map((actor) => [actor.id, actor.name]) ?? []));
	const lines = $derived(detail?.lines ?? []);
	const outstanding = $derived(lines.some((line) => compareDecimals(line.outstandingQuantity, '0') > 0));
	const placedOffsets = $derived(possibleOsloOffsets(headerDraft.placedAt));
	const pendingHere = $derived(Boolean(command && (
		(command.kind === 'receipt' && command.orderId === page.params.id)
		|| (command.kind === 'cancel' && command.orderId === page.params.id)
		|| (command.kind === 'reverse' && command.orderId === page.params.id)
	)));
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));

	function productName(productId: string): string {
		const product = products.get(productId);
		return product ? `${product.code} — ${i18n.locale === 'nb' ? product.name_nb : product.name_en}` : productId;
	}
	function syncPending() {
		if (sendingCommand) return;
		try {
			command = readOrderCommand(localStorage);
			if (command?.kind === 'receipt' && command.orderId === page.params.id) {
				receiptOpen = true;
			} else if (command?.kind === 'cancel' && command.orderId === page.params.id) {
				cancellationQuantities = Object.fromEntries(command.items.map((item) => [item.orderLineId, item.quantity]));
				cancellationReason = command.reason;
				outcome = 'unknown';
			} else if (command?.kind === 'reverse' && command.orderId === page.params.id) {
				reversingId = command.cancellationId;
				reversalReason = command.reason;
				outcome = 'unknown';
			}
		} catch { storageReady = false; }
	}
	onMount(() => {
		mounted = true;
		syncPending();
		void updateOrderStorage((storage) => {
			readOrderCommand(storage);
			const key = 'ampoteket:order-storage-check';
			storage.setItem(key, '1');
			if (storage.getItem(key) !== '1') throw new Error();
			storage.removeItem(key);
		}).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending);
		window.addEventListener(orderStorageEvent, syncPending);
		return () => {
			mounted = false;
			generation++;
			window.removeEventListener('storage', syncPending);
			window.removeEventListener(orderStorageEvent, syncPending);
		};
	});
	$effect(() => {
		const id = page.params.id;
		if (id) untrack(() => {
			if (displayedId !== id) {
				displayedId = id;
				detail = null;
				receiptOpen = page.url.searchParams.has('receive');
				cancellationQuantities = {};
				cancellationReason = '';
				reversalReason = '';
				reversingId = null;
				outcome = 'idle';
				savedAction = null;
				editingHeader = false;
				editingLineId = null;
				headerBasis = null;
				lineBasis = null;
				metadataOutcome = 'idle';
				if (mounted) syncPending();
			}
			void load(id);
		});
	});
	async function load(id = page.params.id!) {
		const version = ++generation;
		loading = true;
		failed = false;
		if (!uuidPattern.test(id)) { detail = null; loading = false; return; }
		const session = admin.credentials();
		try {
			const result = await readOrderDetail(session, id);
			if (mounted && version === generation && admin.session?.user.id === session.userId) detail = result;
		} catch (error) {
			if (mounted && version === generation) failed = true;
			await admin.permissionFailure(error);
		} finally { if (mounted && version === generation) loading = false; }
	}
	function revalidate() {
		if (admin.status === 'ready' && document.visibilityState === 'visible' && !loading && !busy) void load();
	}
	function selectedQuantities(values: Record<string, string>): { line: OrderLine; quantity: string }[] {
		return lines.flatMap((line) => {
			const raw = values[line.id]?.trim();
			if (!raw) return [];
			const product = products.get(line.productId);
			if (!product) throw new Error('Missing order product');
			const quantity = validQuantity(raw, product.stock_step, i18n.locale);
			if (compareDecimals(quantity, line.outstandingQuantity) > 0) throw new Error('Quantity exceeds outstanding');
			return [{ line, quantity }];
		});
	}
	function boundedAmount(input: string, scale: number): string {
		const value = normalizeDecimal(input, i18n.locale);
		if (compareDecimals(value, '0') < 0 || compareDecimals(value, '999999999999') > 0 || (value.split('.')[1]?.length ?? 0) > scale) throw new Error('Invalid amount');
		return value;
	}
	function openHeader(value: Order) {
		editingLineId = null;
		headerBasis = value;
		const placedAt = osloLocal(new Date(value.placedAt));
		const offset = possibleOsloOffsets(placedAt).find((choice) => Math.floor(Date.parse(`${placedAt}:00${choice}`) / 60000) === Math.floor(Date.parse(value.placedAt) / 60000)) ?? '';
		headerDraft = { supplierName: value.supplierName, supplierReference: value.supplierReference ?? '', placedAt, offset, additionalCostNok: value.additionalCostNok, note: value.note ?? '' };
		metadataOutcome = 'idle';
		editingHeader = true;
	}
	function openLine(value: OrderLine) {
		editingHeader = false;
		lineBasis = value;
		lineDraft = { unitCostNok: value.unitCostNok, purchaseUrl: value.purchaseUrl ?? '', supplierSku: value.supplierSku ?? '' };
		metadataOutcome = 'idle';
		editingLineId = value.id;
	}
	async function saveHeader(event: SubmitEvent) {
		event.preventDefault();
		if (!order || !headerBasis || busy || command || !editingHeader) return;
		const basis = headerBasis;
		let target: { supplier_name: string; supplier_reference: string | null; placed_at: string; additional_cost_nok: string; note: string | null };
		try {
			const supplier = headerDraft.supplierName.trim();
			if (!supplier || [...supplier].length > 200 || [...headerDraft.supplierReference].length > 2000 || [...headerDraft.note].length > 2000) throw new Error();
			const placedAt = headerDraft.placedAt === osloLocal(new Date(basis.placedAt)) ? basis.placedAt : osloInstant(headerDraft.placedAt, headerDraft.offset);
			if (Date.parse(placedAt) > Date.parse(basis.recordedAt) + 86_400_000) throw new Error();
			target = { supplier_name: supplier, supplier_reference: headerDraft.supplierReference.trim() || null, placed_at: placedAt,
				additional_cost_nok: boundedAmount(headerDraft.additionalCostNok, 2), note: headerDraft.note.trim() || null };
		} catch { metadataOutcome = 'invalid'; return; }
		busy = true; metadataOutcome = 'idle';
		const session = admin.credentials();
		try {
			const rows = await staffRequest(session, 'amp_purchase_orders', {
				select: 'id', id: staffEquals(basis.id), supplier_name: staffEquals(basis.supplierName),
				supplier_reference: staffEquals(basis.supplierReference), placed_at: staffEquals(basis.placedAt),
				additional_cost_nok: staffEquals(basis.additionalCostNok), note: staffEquals(basis.note)
			}, target, 'PATCH');
			if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid order update');
			if (!rows.length) { metadataOutcome = 'conflict'; await load(); if (order) headerBasis = order; return; }
			if (rows[0]?.id !== basis.id) throw new Error('Invalid order update binding');
			editingHeader = false; metadataOutcome = 'saved'; await load();
		} catch (error) { metadataOutcome = error instanceof ApiError && [400, 409, 422].includes(error.status) ? 'invalid' : 'unknown'; await admin.permissionFailure(error); }
		finally { busy = false; }
	}
	async function saveLine(event: SubmitEvent) {
		event.preventDefault();
		const line = lineBasis;
		if (!line || !order || busy || command) return;
		let target: { unit_cost_nok: string; purchase_url: string | null; supplier_sku: string | null };
		try {
			const purchaseUrl = lineDraft.purchaseUrl.trim();
			if (purchaseUrl) {
				const url = new URL(purchaseUrl);
				if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(purchaseUrl)) throw new Error();
			}
			if ([...lineDraft.supplierSku].length > 2000) throw new Error();
			target = { unit_cost_nok: boundedAmount(lineDraft.unitCostNok, 6), purchase_url: purchaseUrl || null, supplier_sku: lineDraft.supplierSku.trim() || null };
		} catch { metadataOutcome = 'invalid'; return; }
		busy = true; metadataOutcome = 'idle';
		const session = admin.credentials();
		try {
			const rows = await staffRequest(session, 'amp_purchase_order_lines', {
				select: 'id', id: staffEquals(line.id), order_id: staffEquals(order.id), unit_cost_nok: staffEquals(line.unitCostNok),
				purchase_url: staffEquals(line.purchaseUrl), supplier_sku: staffEquals(line.supplierSku)
			}, target, 'PATCH');
			if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid order line update');
			if (!rows.length) { metadataOutcome = 'conflict'; await load(); lineBasis = lines.find((fresh) => fresh.id === line.id) ?? line; return; }
			if (rows[0]?.id !== line.id) throw new Error('Invalid order line update binding');
			editingLineId = null; metadataOutcome = 'saved'; await load();
		} catch (error) { metadataOutcome = error instanceof ApiError && [400, 409, 422].includes(error.status) ? 'invalid' : 'unknown'; await admin.permissionFailure(error); }
		finally { busy = false; }
	}
	async function submit(kind: 'cancel' | 'reverse', event?: SubmitEvent) {
		event?.preventDefault();
		if (!order || busy || loading || failed || !storageReady || wrongIdentity || (command && (!pendingHere || command.kind !== kind))) return;
		let candidate: OrderCommand;
		try {
			const session = admin.credentials();
			if (command) candidate = command;
			else if (kind === 'cancel') {
				const items = selectedQuantities(cancellationQuantities).map(({ line, quantity }) => ({ orderLineId: line.id, quantity }));
				if (!items.length || !cancellationReason.trim()) throw new Error('Invalid cancellation');
				candidate = { kind, userId: session.userId, requestId: crypto.randomUUID(), orderId: order.id, items, reason: cancellationReason.trim() };
			} else {
				if (!reversingId || !reversalReason.trim()) throw new Error('Invalid reversal');
				candidate = { kind, userId: session.userId, requestId: crypto.randomUUID(), orderId: order.id, cancellationId: reversingId, reason: reversalReason.trim() };
			}
		} catch { outcome = 'invalid'; return; }
		busy = true;
		sendingCommand = true;
		outcome = 'idle';
		const session = admin.credentials();
		let frozen: OrderCommand | null = null;
		try {
			frozen = await updateOrderStorage((storage) => saveOrderCommand(storage, candidate));
			command = frozen;
			await runOrderCommand(session, frozen);
			await updateOrderStorage((storage) => clearOrderCommand(storage, frozen!));
			if (mounted && admin.session?.user.id === session.userId) {
				command = null;
				outcome = 'saved';
				savedAction = kind;
				cancellationQuantities = {};
				cancellationReason = '';
				reversalReason = '';
				reversingId = null;
				await load();
			}
		} catch (error) {
			const rejected = frozen ? orderRejection(error) : null;
			if (frozen && rejected) {
				try {
					await updateOrderStorage((storage) => clearOrderCommand(storage, frozen!));
					if (mounted) { command = null; outcome = rejected === 'stale' ? 'conflict' : 'invalid'; await load(); }
				} catch { if (mounted) outcome = 'unknown'; }
			} else if (mounted) outcome = frozen ? 'unknown' : 'invalid';
			await admin.permissionFailure(error);
		} finally { sendingCommand = false; if (mounted) { busy = false; syncPending(); } }
	}
	// Cancelling commits nothing to stock, but it stops the quantity being expected: confirm it first.
	// A pending command was already confirmed, so its retry goes straight through.
	function requestCancel(event: SubmitEvent) {
		event.preventDefault();
		if (command) { void submit('cancel'); return; }
		try { if (!selectedQuantities(cancellationQuantities).length || !cancellationReason.trim()) throw new Error('Invalid cancellation'); }
		catch { outcome = 'invalid'; return; }
		outcome = 'idle'; cancelConfirmOpen = true;
	}
	const reversedIds = $derived(new Set(detail?.cancellations.filter((entry) => entry.reversesId).map((entry) => entry.reversesId) ?? []));
</script>

<svelte:head><title>{m.detailTitle}</title></svelte:head>
<svelte:window onfocus={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}><h1 class={[pageHeading, nameWrap]}>{order?.supplierName ?? m.detailHeading}</h1></header>
<div class={formStatus} aria-live="polite">
		{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{:else if !order && !loading}<Alert.Message appearance="inline" variant="default" role="status">{m.missing}</Alert.Message>{/if}{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>{:else if command && !pendingHere}<Alert.Message appearance="inline" variant="default" role="status">{m.pendingElsewhere}</Alert.Message>{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknown}</Alert.Message>{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalid}</Alert.Message>{:else if outcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.conflict}</Alert.Message>{:else if outcome === 'saved'}<Alert.Message appearance="inline" variant="default" role="status">{savedAction === 'receipt' ? m.receiptRecorded : savedAction === 'cancel' ? m.cancellationRecorded : m.reversalRecorded}</Alert.Message>{/if}
</div>
{#if storageReady && !wrongIdentity && command && !pendingHere}<Button variant="link" href={i18n.href(orderCommandPath(command))}>{m.resumePending}</Button>{/if}
{#if failed}<Button type="button" variant="outline" disabled={loading || busy} onclick={() => load()}>{m.retry}</Button>{/if}
{#if loading && !detail}<span class="sr-only" role="status">{m.loading}</span><div class="min-h-64 space-y-5" aria-busy="true" aria-hidden="true"><Skeleton class="h-6 w-1/2" /><Skeleton class="h-24 w-full" /><Skeleton class="h-24 w-full" /></div>{/if}
{#if order}
	<div class="mb-5"><Button bind:ref={receiptTrigger} type="button" variant="outline" onclick={() => { receiptOpen = true; }} disabled={busy}>{m.openReceipt}</Button></div>
	{#if receiptOpen}<AdminOrderReceipt orderId={order.id} returnFocus={receiptTrigger} onclose={() => { receiptOpen = false; }} onrecorded={async () => { outcome = 'saved'; savedAction = 'receipt'; await load(); }} />{/if}
	<dl class="grid gap-3 md:grid-cols-2 [&_dd]:m-0 [&_dt]:text-sm [&_dt]:text-muted-foreground">
		<div><dt>{m.placedAt}</dt><dd>{formatCountedAt(order.placedAt, i18n.locale)}</dd></div>
		<div><dt>{m.recordedAt}</dt><dd>{formatCountedAt(order.recordedAt, i18n.locale)}</dd></div>
		<div><dt>{m.recordedByLabel}</dt><dd>{actors.get(order.createdBy)}</dd></div>
		{#if order.supplierReference}<div><dt>{m.reference}</dt><dd class="{codeText} wrap-anywhere">{order.supplierReference}</dd></div>{/if}
		<div><dt>{m.additionalCost}</dt><dd class="font-mono">{formatMoney(order.additionalCostNok, i18n.locale)}</dd></div>
		{#if order.note}<div><dt>{m.note}</dt><dd>{order.note}</dd></div>{/if}
	</dl>
	<Collapsible.Root class="mt-4" open={editingHeader} disabled={busy || Boolean(command)} onOpenChange={(open) => { if (open) openHeader(order); else editingHeader = false; }}>
		<DisclosureTrigger>{m.editMetadata}</DisclosureTrigger>
		<Collapsible.Content>
			<form class={[formLayout, 'mt-3']} onsubmit={saveHeader}>
				<Field.Group layout="row">
					<Field.Field width="grow"><Field.Label for={`${fieldId}-supplier`}>{m.supplierName}</Field.Label><Input id={`${fieldId}-supplier`} required maxlength={200} bind:value={headerDraft.supplierName} disabled={busy} /></Field.Field>
					<Field.Field width="medium"><Field.Label for={`${fieldId}-reference`}>{m.reference}</Field.Label><Input id={`${fieldId}-reference`} maxlength={2000} bind:value={headerDraft.supplierReference} disabled={busy} /></Field.Field>
				</Field.Group>
				<Field.Group layout="row">
					<Field.Field width="medium"><Field.Label for={`${fieldId}-placed`}>{m.placedAt}</Field.Label><Input id={`${fieldId}-placed`} type="datetime-local" required bind:value={headerDraft.placedAt} oninput={() => { headerDraft.offset = ''; }} disabled={busy} /></Field.Field>
					{#if placedOffsets.length === 2}<Field.Field width="medium"><Field.Label for={`${fieldId}-offset`}>{m.offset}</Field.Label><NativeSelect.Root id={`${fieldId}-offset`} required bind:value={headerDraft.offset} disabled={busy}><NativeSelect.Option value="">{m.chooseOffset}</NativeSelect.Option><NativeSelect.Option value="+02:00">{m.beforeClockChange}</NativeSelect.Option><NativeSelect.Option value="+01:00">{m.afterClockChange}</NativeSelect.Option></NativeSelect.Root></Field.Field>{/if}
					<Field.Field width="medium"><Field.Label for={`${fieldId}-additional`}>{m.additionalCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-additional`} type="text" inputmode="decimal" required bind:value={headerDraft.additionalCostNok} disabled={busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root></Field.Field>
				</Field.Group>
				<Field.Field><Field.Label for={`${fieldId}-header-note`}>{m.note}</Field.Label><Textarea id={`${fieldId}-header-note`} rows={2} maxlength={2000} bind:value={headerDraft.note} disabled={busy} /></Field.Field>
				<Button type="submit" disabled={busy || Boolean(command)}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.saveOrderMetadata} /></Button>
			</form>
		</Collapsible.Content>
	</Collapsible.Root>
	<div class={formStatus} aria-live="polite">{#if metadataOutcome === 'saved'}<Alert.Message appearance="inline" role="status">{m.metadataSaved}</Alert.Message>{:else if metadataOutcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalidMetadata}</Alert.Message>{:else if metadataOutcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.metadataConflict}</Alert.Message>{:else if metadataOutcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.metadataUnknown}</Alert.Message>{/if}</div>
	{#if metadataOutcome === 'unknown'}<Button type="button" variant="outline" disabled={loading || busy} onclick={() => load()}>{m.reviewMetadata}</Button>{/if}
	<section class={section({ spacing: 'divided' })} aria-labelledby="order-lines-title">
		<Separator />
		<h2 class={sectionHeading} id="order-lines-title">{m.orderLines}</h2>
		<Item.Group>
			{#each lines as line, index (line.id)}
				{#if index > 0}<Item.Separator />{/if}
				{@const unit = unitLabel(products.get(line.productId)?.unit_code, i18n.locale)}
				<Item.Root variant="row" role="listitem">
					<Item.Content class="min-w-0">
						<Item.Title><h3 class={[itemTitle, nameWrap]}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/products/${line.productId}`)}>{productName(line.productId)}</a></h3></Item.Title>
						<Item.Description>{m.lineNumber(line.lineNumber)} · {m.unitCost}: <span class="font-mono">{formatMoney(line.unitCostNok, i18n.locale)}</span>{#if line.supplierSku} · {m.supplierSku}: <span class={codeText}>{line.supplierSku}</span>{/if}</Item.Description>
						<dl class="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-4 [&_dd]:m-0 [&_dd]:font-mono [&_dt]:text-sm [&_dt]:text-muted-foreground">
							<div><dt>{m.ordered}</dt><dd>{formatDecimal(line.orderedQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.orderedQuantity)}</dd></div>
							<div><dt>{m.received}</dt><dd>{formatDecimal(line.receivedQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.receivedQuantity)}</dd></div>
							<div><dt>{m.cancelled}</dt><dd>{formatDecimal(line.cancelledQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.cancelledQuantity)}</dd></div>
							<div><dt>{m.outstanding}</dt><dd>{formatDecimal(line.outstandingQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.outstandingQuantity)}</dd></div>
						</dl>
						{#if line.purchaseUrl}<Button variant="link" class="w-fit" href={line.purchaseUrl} target="_blank" rel="noopener noreferrer">{m.openPurchaseUrl}</Button>{/if}
						<Collapsible.Root open={editingLineId === line.id} disabled={busy || Boolean(command)} onOpenChange={(open) => { if (open) openLine(line); else editingLineId = null; }}>
							<DisclosureTrigger>{m.editMetadata}</DisclosureTrigger>
							<Collapsible.Content>
								<form class={[formLayout, 'mt-3']} onsubmit={saveLine}>
									<Field.Group layout="row">
										<Field.Field width="medium"><Field.Label for={`${fieldId}-cost-${line.id}`}>{m.unitCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-cost-${line.id}`} type="text" inputmode="decimal" required bind:value={lineDraft.unitCostNok} disabled={busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root></Field.Field>
										<Field.Field width="medium"><Field.Label for={`${fieldId}-sku-${line.id}`}>{m.supplierSku}</Field.Label><Input id={`${fieldId}-sku-${line.id}`} maxlength={2000} bind:value={lineDraft.supplierSku} disabled={busy} /></Field.Field>
									</Field.Group>
									<Field.Field><Field.Label for={`${fieldId}-url-${line.id}`}>{m.purchaseUrl}</Field.Label><Input id={`${fieldId}-url-${line.id}`} type="url" bind:value={lineDraft.purchaseUrl} disabled={busy} /></Field.Field>
									<Button type="submit" disabled={busy || Boolean(command)}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.saveLineMetadata} /></Button>
								</form>
							</Collapsible.Content>
						</Collapsible.Root>
					</Item.Content>
				</Item.Root>
			{/each}
		</Item.Group>
	</section>
	{#if outstanding || (pendingHere && command?.kind === 'cancel')}
		<section class={section({ spacing: 'divided' })} aria-labelledby="cancel-title">
			<Separator />
			<h2 class={sectionHeading} id="cancel-title">{m.cancelHeading}</h2>
			<form class={formLayout} onsubmit={requestCancel}>
				{#each lines.filter((line) => compareDecimals(line.outstandingQuantity, '0') > 0 || cancellationQuantities[line.id]) as line (line.id)}
					{@const unit = unitLabel(products.get(line.productId)?.unit_code, i18n.locale)}
					<Field.Field>
						<Field.Label for={`${fieldId}-cancel-${line.id}`} class={nameWrap}>{productName(line.productId)}{#if unit}<span class="sr-only">{` (${unit})`}</span>{/if}</Field.Label>
						<Field.Description id={`${fieldId}-cancel-hint-${line.id}`}>{m.lineNumber(line.lineNumber)} · {m.outstanding} <span class="font-mono">{formatDecimal(line.outstandingQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.outstandingQuantity)}</span></Field.Description>
						<InputGroup.Root class="max-w-48"><InputGroup.Input id={`${fieldId}-cancel-${line.id}`} type="text" inputmode="decimal" autocomplete="off" aria-describedby={`${fieldId}-cancel-hint-${line.id}`} bind:value={cancellationQuantities[line.id]} disabled={busy || Boolean(command)} />{#if unit}<InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unit}</InputGroup.Text></InputGroup.Addon>{/if}</InputGroup.Root>
					</Field.Field>
				{/each}
				<Field.Field><Field.Label for={`${fieldId}-cancel-reason`}>{m.cancelReason}</Field.Label><Textarea id={`${fieldId}-cancel-reason`} rows={2} maxlength={2000} required bind:value={cancellationReason} disabled={busy || Boolean(command)} /></Field.Field>
				<Button bind:ref={cancelTrigger} type="submit" disabled={busy || loading || failed || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind !== 'cancel'))}><ButtonLabel pending={busy} pendingLabel={m.working} label={command?.kind === 'cancel' && pendingHere ? m.retrySame : m.cancelSelected} reserveLabels={[m.retrySame, m.cancelSelected]} /></Button>
			</form>
			<AlertDialog.Root bind:open={cancelConfirmOpen}>
				<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); cancelTrigger?.focus({ preventScroll: true }); }}>
					<AlertDialog.Header>
						<AlertDialog.Title>{m.cancelSelected}</AlertDialog.Title>
						<AlertDialog.Description>{m.cancelConfirm}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{m.keepOrder}</AlertDialog.Cancel>
						<AlertDialog.Action disabled={busy} onclick={() => { cancelConfirmOpen = false; void submit('cancel'); }}>{m.cancelSelected}</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</section>
	{/if}
	<!-- Read-only histories appear once they have entries. -->
	{#if detail?.receipts.length}
	<section class={section({ spacing: 'divided' })} aria-labelledby="receipt-history-title">
		<Separator />
		<h2 class={sectionHeading} id="receipt-history-title">{m.receiptHistory}</h2>
		<Item.Group>
			{#each detail?.receipts ?? [] as receipt, index (receipt.id)}
				{#if index > 0}<Item.Separator />{/if}
				{@const occurred = formatCountedAt(receipt.occurredAt, i18n.locale)}
				{@const recorded = formatCountedAt(receipt.recordedAt, i18n.locale)}
				<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0">
					<Item.Title><h3 class={itemTitle}>{receipt.kind === 'receipt' ? m.receivedAt : m.historyCorrection}</h3></Item.Title>
					<Item.Description>{occurred} · {m.recordedBy(actors.get(receipt.actorId) ?? '')}{#if recorded !== occurred} · {m.recordedAt}: {recorded}{/if}</Item.Description>
					{#if receipt.note}<p class="text-sm">{receipt.note}</p>{/if}
						<ul class="mt-2 space-y-1 text-sm">{#each receipt.movements as movement (movement.id)}{@const line = lines.find((item) => item.id === movement.orderLineId)}<li class={nameWrap}>{line ? `${m.lineNumber(line.lineNumber)} · ` : ''}{productName(movement.productId)}: <span class="font-mono">{formatDecimal(movement.quantityDelta, i18n.locale)} {unitLabel(products.get(movement.productId)?.unit_code, i18n.locale, movement.quantityDelta)}</span></li>{/each}</ul>
				</Item.Content></Item.Root>
			{/each}
		</Item.Group>
	</section>
	{/if}
	{#if detail?.cancellations.length}
	<section class={section({ spacing: 'divided' })} aria-labelledby="cancellation-history-title">
		<Separator />
		<h2 class={sectionHeading} id="cancellation-history-title">{m.cancellationHistory}</h2>
		<Item.Group>
			{#each detail?.cancellations ?? [] as entry, index (entry.id)}
				{#if index > 0}<Item.Separator />{/if}
				{@const line = lines.find((line) => line.id === entry.orderLineId)}
				<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0">
					<Item.Title><h3 class={itemTitle}>{entry.reversesId ? m.reversalRecorded : m.cancellationRecorded}</h3></Item.Title>
					<Item.Description>{formatCountedAt(entry.recordedAt, i18n.locale)} · {m.recordedBy(actors.get(entry.createdBy) ?? '')} · {line ? `${m.lineNumber(line.lineNumber)} · ${productName(line.productId)}` : entry.orderLineId} · <span class="font-mono">{formatDecimal(entry.quantity, i18n.locale)} {line ? unitLabel(products.get(line.productId)?.unit_code, i18n.locale, entry.quantity) : ''}</span></Item.Description>
					<p class="text-sm">{entry.reason}</p>
					{#if !entry.reversesId && !reversedIds.has(entry.id)}
						<Collapsible.Root open={reversingId === entry.id} disabled={busy || Boolean(command)} onOpenChange={(open) => { reversingId = open ? entry.id : null; reversalReason = ''; }}>
							<DisclosureTrigger>{m.reverseCancellation}</DisclosureTrigger>
							<Collapsible.Content>
								<form class={[formLayout, 'mt-3']} onsubmit={(event) => submit('reverse', event)}><Field.Field><Field.Label for={`${fieldId}-reverse-${entry.id}`}>{m.reason}</Field.Label><Textarea id={`${fieldId}-reverse-${entry.id}`} rows={2} maxlength={2000} required bind:value={reversalReason} disabled={busy || Boolean(command)} /></Field.Field><Button type="submit" disabled={busy || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind !== 'reverse'))}><ButtonLabel pending={busy} pendingLabel={m.working} label={command?.kind === 'reverse' && pendingHere ? m.retrySame : m.reverseCancellation} reserveLabels={[m.retrySame, m.reverseCancellation]} /></Button></form>
							</Collapsible.Content>
						</Collapsible.Root>
					{/if}
				</Item.Content></Item.Root>
			{/each}
		</Item.Group>
	</section>
	{/if}
{/if}
