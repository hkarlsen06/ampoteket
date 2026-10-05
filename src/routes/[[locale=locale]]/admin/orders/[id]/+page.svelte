<script lang="ts">
	import StateBadge from '#lib/StateBadge.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { ApiError, uuidPattern } from '#lib/api.js';
	import { compareDecimals, normalizeDecimal, validQuantity } from '#lib/decimal.js';
	import { currencySymbol, formatCountedAt, formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	import { osloInstant, osloLocal, possibleOsloOffsets } from '#lib/oslo-time.js';
	import { staffEquals, staffRequest } from '#lib/admin-api.js';
	import AdminOrderReceipt from '#lib/AdminOrderReceipt.svelte';
	import { clearOrderCommand, orderProductName, orderCommandPath, orderRejection, orderStorageEvent, readOrderCommand, readOrderDetail, runOrderCommand, saveOrderCommand, updateOrderStorage, type Order, type OrderCommand, type OrderDetail, type OrderLine } from '#lib/admin-orders.js';
	import { codeText, formActions, formLayout, formStatus, itemTitle, nameWrap, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	const i18n = getI18n();
	const admin = getAdminContext();
	const m = $derived(i18n.m.adminOrders);
	const fieldId = $props.id();
	let detail = $state<OrderDetail | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let busy = $state(false);
	let invalidInput = $state(''); let invalidMessage = $state('');
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
	let cancellationOpen = $state(false);
	let reverseConfirmOpen = $state(false);
	let reverseTrigger = $state<HTMLButtonElement | null>(null);
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
		return product ? `${product.code}: ${orderProductName(product, i18n.locale)}` : orderProductName(undefined, i18n.locale);
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
				cancellationOpen = true;
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
				cancellationOpen = false;
				cancelConfirmOpen = false;
				reverseConfirmOpen = false;
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
		if (admin.status !== 'ready') return;
		const version = ++generation;
		loading = true;
		failed = false;
		if (!uuidPattern.test(id)) { detail = null; loading = false; return; }
		try {
			const session = admin.credentials();
			const result = await readOrderDetail(session, id);
			if (mounted && version === generation && admin.session?.user.id === session.userId) detail = result;
		} catch (error) {
			if (mounted && version === generation) failed = true;
			await admin.permissionFailure(error);
		} finally { if (mounted && version === generation) loading = false; }
	}
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(loading || busy)) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	function checked<T>(suffix: string, message: string, parse: () => T): T {
		try { return parse(); }
		catch (error) { invalidInput = `${fieldId}-${suffix}`; invalidMessage = message; throw error; }
	}
	function focusInvalid() { void tick().then(() => document.getElementById(invalidInput)?.focus()); }
	function selectedQuantities(values: Record<string, string>): { line: OrderLine; quantity: string }[] {
		return lines.flatMap((line) => {
			const raw = values[line.id]?.trim();
			if (!raw) return [];
			const product = products.get(line.productId);
			if (!product) throw new Error('Missing order product');
			const quantity = checked(`cancel-${line.id}`, m.invalidQuantity(formatDecimal(product.stock_step, i18n.locale)), () => validQuantity(raw, product.stock_step, i18n.locale));
			checked(`cancel-${line.id}`, m.exceedsOutstanding(formatDecimal(line.outstandingQuantity, i18n.locale), unitLabel(product.unit_code, i18n.locale, line.outstandingQuantity)), () => { if (compareDecimals(quantity, line.outstandingQuantity) > 0) throw new Error('Quantity exceeds outstanding'); });
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
		if (admin.status !== 'ready' || loading || failed || !order || !headerBasis || busy || command || !editingHeader) return;
		const basis = headerBasis; invalidInput = ''; invalidMessage = '';
		let target: { supplier_name: string; supplier_reference: string | null; placed_at: string; additional_cost_nok: string; note: string | null };
		try {
			const supplier = headerDraft.supplierName.trim();
			checked('supplier', m.invalidMetadata, () => { if (!supplier || [...supplier].length > 200) throw new Error(); });
			checked('reference', m.invalidMetadata, () => { if ([...headerDraft.supplierReference].length > 2000) throw new Error(); });
			const placedAt = checked('placed', placedOffsets.length === 2 && !headerDraft.offset ? m.ambiguousDate : m.invalidDate, () => {
				const value = headerDraft.placedAt === osloLocal(new Date(basis.placedAt)) ? basis.placedAt : osloInstant(headerDraft.placedAt, headerDraft.offset);
				if (Date.parse(value) > Date.parse(basis.recordedAt) + 86_400_000) throw new Error(); return value;
			});
			const additionalCost = checked('additional', m.invalidCost(2), () => boundedAmount(headerDraft.additionalCostNok, 2));
			checked('header-note', m.invalidMetadata, () => { if ([...headerDraft.note].length > 2000) throw new Error(); });
			target = { supplier_name: supplier, supplier_reference: headerDraft.supplierReference.trim() || null, placed_at: placedAt,
				additional_cost_nok: additionalCost, note: headerDraft.note.trim() || null };
		} catch { metadataOutcome = 'invalid'; focusInvalid(); return; }
		busy = true; metadataOutcome = 'idle';
		try {
			const session = admin.credentials();
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
		if (admin.status !== 'ready' || loading || failed || !line || !order || busy || command) return;
		invalidInput = ''; invalidMessage = '';
		let target: { unit_cost_nok: string; purchase_url: string | null; supplier_sku: string | null };
		try {
			const unitCost = checked(`cost-${line.id}`, m.invalidCost(6), () => boundedAmount(lineDraft.unitCostNok, 6));
			checked(`sku-${line.id}`, m.invalidMetadata, () => { if ([...lineDraft.supplierSku].length > 2000) throw new Error(); });
			const purchaseUrl = checked(`url-${line.id}`, i18n.m.adminProducts.invalidLink, () => {
				const value = lineDraft.purchaseUrl.trim(); if (!value) return value; const url = new URL(value);
				if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(value)) throw new Error(); return value;
			});
			target = { unit_cost_nok: unitCost, purchase_url: purchaseUrl || null, supplier_sku: lineDraft.supplierSku.trim() || null };
		} catch { metadataOutcome = 'invalid'; focusInvalid(); return; }
		busy = true; metadataOutcome = 'idle';
		try {
			const session = admin.credentials();
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
		if (admin.status !== 'ready' || !order || busy || loading || failed || !storageReady || wrongIdentity || (command && (!pendingHere || command.kind !== kind))) return;
		let candidate: OrderCommand; invalidInput = ''; invalidMessage = '';
		try {
			const session = admin.credentials();
			if (command) candidate = command;
			else if (kind === 'cancel') {
				const items = selectedQuantities(cancellationQuantities).map(({ line, quantity }) => ({ orderLineId: line.id, quantity }));
				checked(items.length ? 'cancel-reason' : `cancel-${lines.find(line => compareDecimals(line.outstandingQuantity, '0') > 0)?.id}`, m.invalid, () => { if (!items.length || !cancellationReason.trim()) throw new Error('Invalid cancellation'); });
				candidate = { kind, userId: session.userId, requestId: crypto.randomUUID(), orderId: order.id, items, reason: cancellationReason.trim() };
			} else {
				if (!reversingId) throw new Error('Missing cancellation');
				checked(`reverse-${reversingId}`, m.invalid, () => { if (!reversalReason.trim()) throw new Error('Invalid reversal'); });
				candidate = { kind, userId: session.userId, requestId: crypto.randomUUID(), orderId: order.id, cancellationId: reversingId, reason: reversalReason.trim() };
			}
		} catch { outcome = 'invalid'; focusInvalid(); return; }
		busy = true;
		sendingCommand = true;
		outcome = 'idle';
		let frozen: OrderCommand | null = null;
		try {
			const session = admin.credentials();
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
				cancellationOpen = false;
				cancelConfirmOpen = false;
				reverseConfirmOpen = false;
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
		invalidInput = ''; invalidMessage = '';
		try { const selected = selectedQuantities(cancellationQuantities); checked(selected.length ? 'cancel-reason' : `cancel-${lines.find(line => compareDecimals(line.outstandingQuantity, '0') > 0)?.id}`, m.invalid, () => { if (!selected.length || !cancellationReason.trim()) throw new Error('Invalid cancellation'); }); }
		catch { outcome = 'invalid'; focusInvalid(); return; }
		outcome = 'idle'; cancelConfirmOpen = true;
	}
	function requestReverse(event: SubmitEvent) {
		event.preventDefault();
		if (command) { void submit('reverse'); return; }
		invalidInput = ''; invalidMessage = '';
		try { checked(`reverse-${reversingId}`, m.invalid, () => { if (!reversingId || !reversalReason.trim()) throw new Error('Invalid reversal'); }); }
		catch { outcome = 'invalid'; focusInvalid(); return; }
		reverseTrigger = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
		outcome = 'idle'; reverseConfirmOpen = true;
	}
	const reversedIds = $derived(new Set(detail?.cancellations.filter((entry) => entry.reversesId).map((entry) => entry.reversesId) ?? []));
</script>

{#snippet fieldError(id: string)}{#if invalidInput === id}<Field.Error id={`${id}-error`}>{invalidMessage}</Field.Error>{/if}{/snippet}
<svelte:head><title>{m.detailTitle(order?.supplierName ?? m.detailHeading)}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={[pageHeading, nameWrap]}>{order?.supplierName ?? m.detailHeading}</h1>
	{#if order && outstanding}<div class={formActions}><Button bind:ref={receiptTrigger} type="button" variant="outline" aria-haspopup="dialog" onclick={() => { receiptOpen = true; }} disabled={busy}>{m.openReceipt}</Button></div>{/if}
</header>
<div class={formStatus} aria-live="polite">
		{#if failed}<Alert.Message appearance="inline" variant="destructive">{m.detailUnavailable}</Alert.Message>{:else if !order && !loading}<Alert.Message appearance="inline" variant="default">{m.missing}</Alert.Message>{/if}{#if !storageReady}<Alert.Message appearance="inline" variant="destructive">{m.storageUnavailable}</Alert.Message>{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive">{m.wrongIdentity}</Alert.Message>{:else if command && !pendingHere}<Alert.Message appearance="inline" variant="default">{m.pendingElsewhere}</Alert.Message>{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive">{m.unknown}</Alert.Message>{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive">{m.invalid}</Alert.Message>{:else if outcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive">{m.conflict}</Alert.Message>{:else if outcome === 'saved'}<StateBadge tone="success">{savedAction === 'receipt' ? m.receiptRecorded : savedAction === 'cancel' ? m.cancellationRecorded : m.reversalRecorded}</StateBadge>{/if}
</div>
{#if storageReady && !wrongIdentity && command && !pendingHere}<Button variant="link" href={i18n.href(orderCommandPath(command))}>{m.resumePending}</Button>{/if}
{#if failed}<Button type="button" variant="outline" disabled={loading || busy} onclick={() => load()}>{m.retry}</Button>{/if}
{#if loading && !detail}<span class="sr-only" role="status">{m.loading}</span><div class="min-h-64 space-y-5" aria-busy="true" aria-hidden="true"><Skeleton class="h-6 w-1/2" /><Skeleton class="h-24 w-full" /><Skeleton class="h-24 w-full" /></div>{/if}
{#if order}
	{#if receiptOpen}<AdminOrderReceipt orderId={order.id} returnFocus={receiptTrigger} onclose={() => { receiptOpen = false; }} onrecorded={async () => { outcome = 'saved'; savedAction = 'receipt'; await load(); }} />{/if}
	<dl class="grid gap-3 md:grid-cols-2 [&_dd]:m-0 [&_dt]:text-sm [&_dt]:text-muted-foreground">
		<div><dt>{m.placedAt}</dt><dd>{formatCountedAt(order.placedAt, i18n.locale)}</dd></div>
		<div><dt>{m.recordedAt}</dt><dd>{formatCountedAt(order.recordedAt, i18n.locale)}</dd></div>
		<div><dt>{m.recordedByLabel}</dt><dd>{actors.get(order.createdBy) || m.unknownActor}</dd></div>
		{#if order.supplierReference}<div><dt>{m.referenceLabel}</dt><dd class="{codeText} wrap-anywhere">{order.supplierReference}</dd></div>{/if}
		<div><dt>{m.additionalCost}</dt><dd class="font-mono">{formatMoney(order.additionalCostNok, i18n.locale)}</dd></div>
		{#if order.note}<div><dt>{m.noteLabel}</dt><dd>{order.note}</dd></div>{/if}
	</dl>
	<Collapsible.Root class="mt-4" open={editingHeader} disabled={loading || failed || busy || Boolean(command)} onOpenChange={(open) => { if (open) openHeader(order); else editingHeader = false; }}>
		<DisclosureTrigger>{m.editMetadata}</DisclosureTrigger>
		<Collapsible.Content>
			<form class={[formLayout, 'mt-3']} onsubmit={saveHeader}>
				<Field.Group layout="row">
					<Field.Field width="grow"><Field.Label for={`${fieldId}-supplier`}>{m.supplierName}</Field.Label><Input id={`${fieldId}-supplier`} autocapitalize="words" aria-invalid={invalidInput === `${fieldId}-supplier`} aria-describedby={invalidInput === `${fieldId}-supplier` ? `${fieldId}-supplier`.concat('-error') : undefined} required maxlength={200} bind:value={headerDraft.supplierName} disabled={busy} />{@render fieldError(`${fieldId}-supplier`)}</Field.Field>
					<Field.Field width="medium"><Field.Label for={`${fieldId}-reference`}>{m.reference}</Field.Label><Input id={`${fieldId}-reference`} aria-invalid={invalidInput === `${fieldId}-reference`} aria-describedby={invalidInput === `${fieldId}-reference` ? `${fieldId}-reference`.concat('-error') : undefined} maxlength={2000} bind:value={headerDraft.supplierReference} disabled={busy} />{@render fieldError(`${fieldId}-reference`)}</Field.Field>
				</Field.Group>
				<Field.Group layout="row">
					<Field.Field width="medium"><Field.Label for={`${fieldId}-placed`}>{m.placedAt}</Field.Label><Input id={`${fieldId}-placed`} aria-invalid={invalidInput === `${fieldId}-placed`} aria-describedby={invalidInput === `${fieldId}-placed` ? `${fieldId}-placed`.concat('-error') : undefined} type="datetime-local" required bind:value={headerDraft.placedAt} oninput={() => { headerDraft.offset = ''; }} disabled={busy} />{@render fieldError(`${fieldId}-placed`)}</Field.Field>
					{#if placedOffsets.length === 2}<Field.Field width="medium"><Field.Label for={`${fieldId}-offset`}>{m.offset}</Field.Label><NativeSelect.Root id={`${fieldId}-offset`} required bind:value={headerDraft.offset} disabled={busy}><NativeSelect.Option value="">{m.chooseOffset}</NativeSelect.Option><NativeSelect.Option value="+02:00">{m.beforeClockChange}</NativeSelect.Option><NativeSelect.Option value="+01:00">{m.afterClockChange}</NativeSelect.Option></NativeSelect.Root></Field.Field>{/if}
					<Field.Field width="medium"><Field.Label for={`${fieldId}-additional`}>{m.additionalCost} <span class="sr-only">({currencySymbol(i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-additional`} aria-invalid={invalidInput === `${fieldId}-additional`} aria-describedby={invalidInput === `${fieldId}-additional` ? `${fieldId}-additional`.concat('-error') : undefined} type="text" inputmode="decimal" required bind:value={headerDraft.additionalCostNok} disabled={busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{currencySymbol(i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError(`${fieldId}-additional`)}</Field.Field>
				</Field.Group>
				<Field.Field><Field.Label for={`${fieldId}-header-note`}>{m.note}</Field.Label><Textarea id={`${fieldId}-header-note`} aria-invalid={invalidInput === `${fieldId}-header-note`} aria-describedby={invalidInput === `${fieldId}-header-note` ? `${fieldId}-header-note`.concat('-error') : undefined} rows={2} maxlength={2000} bind:value={headerDraft.note} disabled={busy} />{@render fieldError(`${fieldId}-header-note`)}</Field.Field>
				<Button type="submit" disabled={loading || failed || busy || Boolean(command)}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.saveOrderMetadata} /></Button>
			</form>
		</Collapsible.Content>
	</Collapsible.Root>
	<div class={formStatus} aria-live="polite">{#if metadataOutcome === 'saved'}<StateBadge tone="success">{m.metadataSaved}</StateBadge>{:else if metadataOutcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive">{m.invalidMetadata}</Alert.Message>{:else if metadataOutcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive">{m.metadataConflict}</Alert.Message>{:else if metadataOutcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive">{m.metadataUnknown}</Alert.Message>{/if}</div>
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
						<Item.Description>{m.lineNumber(line.lineNumber)}</Item.Description>
						<dl class="grid grid-cols-1 gap-x-5 gap-y-2 md:grid-cols-2 [&_dd]:m-0 [&_dd]:font-mono [&_dt]:text-sm [&_dt]:text-muted-foreground">
							<div class="min-w-0"><dt>{m.unitCost}</dt><dd>{formatMoney(line.unitCostNok, i18n.locale)}</dd></div>
							{#if line.supplierSku}<div class="min-w-0"><dt>{m.supplierSkuLabel}</dt><dd class="wrap-anywhere">{line.supplierSku}</dd></div>{/if}
						</dl>
						<dl class="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-4 [&_dd]:m-0 [&_dd]:font-mono [&_dt]:text-sm [&_dt]:text-muted-foreground">
							<div><dt>{m.ordered}</dt><dd>{formatDecimal(line.orderedQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.orderedQuantity)}</dd></div>
							<div><dt>{m.received}</dt><dd>{formatDecimal(line.receivedQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.receivedQuantity)}</dd></div>
							<div><dt>{m.cancelled}</dt><dd>{formatDecimal(line.cancelledQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.cancelledQuantity)}</dd></div>
							<div><dt>{m.outstanding}</dt><dd>{formatDecimal(line.outstandingQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.outstandingQuantity)}</dd></div>
						</dl>
						{#if line.purchaseUrl}<Button variant="link" class="w-fit" href={line.purchaseUrl} target="_blank" rel="noopener noreferrer">{m.openPurchaseUrl}</Button>{/if}
						<Collapsible.Root open={editingLineId === line.id} disabled={loading || failed || busy || Boolean(command)} onOpenChange={(open) => { if (open) openLine(line); else editingLineId = null; }}>
							<DisclosureTrigger><span aria-hidden="true">{m.editMetadata}</span><span class="sr-only">{m.editLineMetadata(productName(line.productId), line.lineNumber)}</span></DisclosureTrigger>
							<Collapsible.Content>
								<form class={[formLayout, 'mt-3']} onsubmit={saveLine}>
									<Field.Group layout="row">
										<Field.Field width="medium"><Field.Label for={`${fieldId}-cost-${line.id}`}>{m.unitCost} <span class="sr-only">({currencySymbol(i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-cost-${line.id}`} aria-invalid={invalidInput === `${fieldId}-cost-${line.id}`} aria-describedby={invalidInput === `${fieldId}-cost-${line.id}` ? `${fieldId}-cost-${line.id}`.concat('-error') : undefined} type="text" inputmode="decimal" required bind:value={lineDraft.unitCostNok} disabled={busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{currencySymbol(i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError(`${fieldId}-cost-${line.id}`)}</Field.Field>
										<Field.Field width="medium"><Field.Label for={`${fieldId}-sku-${line.id}`}>{m.supplierSku}</Field.Label><Input id={`${fieldId}-sku-${line.id}`} aria-invalid={invalidInput === `${fieldId}-sku-${line.id}`} aria-describedby={invalidInput === `${fieldId}-sku-${line.id}` ? `${fieldId}-sku-${line.id}`.concat('-error') : undefined} maxlength={2000} bind:value={lineDraft.supplierSku} disabled={busy} />{@render fieldError(`${fieldId}-sku-${line.id}`)}</Field.Field>
									</Field.Group>
									<Field.Field><Field.Label for={`${fieldId}-url-${line.id}`}>{m.purchaseUrl}</Field.Label><Input id={`${fieldId}-url-${line.id}`} aria-invalid={invalidInput === `${fieldId}-url-${line.id}`} aria-describedby={invalidInput === `${fieldId}-url-${line.id}` ? `${fieldId}-url-${line.id}`.concat('-error') : undefined} type="url" autocapitalize="none" enterkeyhint="go" bind:value={lineDraft.purchaseUrl} disabled={busy} />{@render fieldError(`${fieldId}-url-${line.id}`)}</Field.Field>
									<Button type="submit" disabled={loading || failed || busy || Boolean(command)}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.saveLineMetadata} /></Button>
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
			<Collapsible.Root bind:open={cancellationOpen}>
			<DisclosureTrigger><span id="cancel-title">{m.cancelHeading}</span></DisclosureTrigger>
			<Collapsible.Content class="mt-3">
			<form class={formLayout} onsubmit={requestCancel}>
				{#each lines.filter((line) => compareDecimals(line.outstandingQuantity, '0') > 0 || cancellationQuantities[line.id]) as line (line.id)}
					{@const unit = unitLabel(products.get(line.productId)?.unit_code, i18n.locale)}
					<Field.Field>
						<Field.Label for={`${fieldId}-cancel-${line.id}`} class={nameWrap}>{productName(line.productId)}{#if unit}<span class="sr-only">{` (${unit})`}</span>{/if}</Field.Label>
						<Field.Description id={`${fieldId}-cancel-hint-${line.id}`}>{m.lineNumber(line.lineNumber)} · {m.outstanding} <span class="font-mono">{formatDecimal(line.outstandingQuantity, i18n.locale)} {unitLabel(unit, i18n.locale, line.outstandingQuantity)}</span></Field.Description>
						<InputGroup.Root class="max-w-48"><InputGroup.Input id={`${fieldId}-cancel-${line.id}`} aria-invalid={invalidInput === `${fieldId}-cancel-${line.id}`} type="text" inputmode="decimal" autocomplete="off" aria-describedby={`${fieldId}-cancel-hint-${line.id}${invalidInput === `${fieldId}-cancel-${line.id}` ? ` ${fieldId}-cancel-${line.id}-error` : ''}`} bind:value={cancellationQuantities[line.id]} disabled={loading || failed || busy || Boolean(command)} />{#if unit}<InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unit}</InputGroup.Text></InputGroup.Addon>{/if}</InputGroup.Root>
					{@render fieldError(`${fieldId}-cancel-${line.id}`)}</Field.Field>
				{/each}
				<Field.Field><Field.Label for={`${fieldId}-cancel-reason`}>{m.cancelReason}</Field.Label><Textarea id={`${fieldId}-cancel-reason`} aria-invalid={invalidInput === `${fieldId}-cancel-reason`} aria-describedby={invalidInput === `${fieldId}-cancel-reason` ? `${fieldId}-cancel-reason`.concat('-error') : undefined} rows={2} maxlength={2000} required bind:value={cancellationReason} disabled={loading || failed || busy || Boolean(command)} />{@render fieldError(`${fieldId}-cancel-reason`)}</Field.Field>
				<Button bind:ref={cancelTrigger} variant="outline" type="submit" disabled={busy || loading || failed || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind !== 'cancel'))}><ButtonLabel pending={busy} pendingLabel={m.working} label={command?.kind === 'cancel' && pendingHere ? m.retryCancel : m.cancelSelected} reserveLabels={[m.retryCancel, m.cancelSelected]} /></Button>
			</form>
			</Collapsible.Content>
			</Collapsible.Root>
			<AlertDialog.Root bind:open={cancelConfirmOpen}>
				<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); cancelTrigger?.focus({ preventScroll: true }); }}>
					<AlertDialog.Header>
						<AlertDialog.Title>{m.cancelSelected}</AlertDialog.Title>
						<AlertDialog.Description aria-label={m.cancelSelected}>{m.cancelConfirm}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{m.cancel}</AlertDialog.Cancel>
						<AlertDialog.Action variant="destructive" disabled={admin.status !== 'ready' || loading || failed || busy} onclick={() => { cancelConfirmOpen = false; void submit('cancel'); }}>{m.cancelSelected}</AlertDialog.Action>
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
					<Item.Description>{occurred} · {m.recordedBy(actors.get(receipt.actorId) || m.unknownActor)}{#if recorded !== occurred}&nbsp;· {m.recordedAt}: {recorded}{/if}</Item.Description>
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
					<Item.Title><h3 class={itemTitle}>{entry.reversesId ? m.reversalEntry : m.cancellationEntry}</h3></Item.Title>
					<Item.Description>{formatCountedAt(entry.recordedAt, i18n.locale)} · {m.recordedBy(actors.get(entry.createdBy) || m.unknownActor)} · {line ? `${m.lineNumber(line.lineNumber)} · ${productName(line.productId)}` : orderProductName(undefined, i18n.locale)} · <span class="font-mono">{formatDecimal(entry.quantity, i18n.locale)} {line ? unitLabel(products.get(line.productId)?.unit_code, i18n.locale, entry.quantity) : ''}</span></Item.Description>
					<p class="text-sm">{entry.reason}</p>
					{#if !entry.reversesId && !reversedIds.has(entry.id)}
						<Collapsible.Root open={reversingId === entry.id} disabled={loading || failed || busy || Boolean(command)} onOpenChange={(open) => { reversingId = open ? entry.id : null; reversalReason = ''; }}>
							<DisclosureTrigger>{m.reverseCancellation}</DisclosureTrigger>
							<Collapsible.Content>
								<form class={[formLayout, 'mt-3']} onsubmit={requestReverse}><Field.Field><Field.Label for={`${fieldId}-reverse-${entry.id}`}>{m.reason}</Field.Label><Textarea id={`${fieldId}-reverse-${entry.id}`} aria-invalid={invalidInput === `${fieldId}-reverse-${entry.id}`} aria-describedby={invalidInput === `${fieldId}-reverse-${entry.id}` ? `${fieldId}-reverse-${entry.id}-error` : undefined} rows={2} maxlength={2000} required bind:value={reversalReason} disabled={loading || failed || busy || Boolean(command)} />{@render fieldError(`${fieldId}-reverse-${entry.id}`)}</Field.Field><Button type="submit" variant="outline" disabled={busy || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind !== 'reverse'))}><ButtonLabel pending={busy} pendingLabel={m.working} label={command?.kind === 'reverse' && pendingHere ? m.retryReverse : m.reverseCancellation} reserveLabels={[m.retryReverse, m.reverseCancellation]} /></Button></form>
							</Collapsible.Content>
						</Collapsible.Root>
					{/if}
				</Item.Content></Item.Root>
			{/each}
		</Item.Group>
	</section>
	{/if}
{/if}

<AlertDialog.Root bind:open={reverseConfirmOpen}>
	<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); reverseTrigger?.focus({ preventScroll: true }); }}>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.reverseCancellation}</AlertDialog.Title>
			<AlertDialog.Description aria-label={m.reverseCancellation}>{m.reverseConfirm}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.cancel}</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" disabled={admin.status !== 'ready' || loading || failed || busy} onclick={() => { reverseConfirmOpen = false; void submit('reverse'); }}>{m.reverseCancellation}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
