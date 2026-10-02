<script lang="ts">
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { productName } from '#lib/catalog.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack, onMount, tick } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { compareDecimals, normalizeDecimal, validQuantity } from '#lib/decimal.js';
	import { osloInstant, osloLocal, possibleOsloOffsets } from '#lib/oslo-time.js';
	import { formatCountedAt, formatDecimal, unitLabel } from '#lib/format.js';
	import { clearOrderCommand, orderCommandPath, orderRejection, orderStorageEvent, readOrderCommand, readOrderProducts, readOrders, readOutstandingByProduct, readUnplannedReceipts, runOrderCommand, saveOrderCommand, updateOrderStorage, type Order, type OrderCommand, type OrderProduct, type OrderReceipt } from '#lib/admin-orders.js';
	import { compareAttention, readInventory, stockRank } from '#lib/admin-products.js';
	import { Toggle, toggleVariants } from '#lib/components/ui/toggle/index.js';
	import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
	import StockBadge from '#lib/StockBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import TruckIcon from 'phosphor-svelte/lib/TruckIcon';
	import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
	import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon';
	import { codeText, formActions, formLayout, formStatus, itemTitle, nameWrap, pageHeader, pageHeading, section, sectionHeading, sheetBody } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import OrderProductCombobox from '#lib/OrderProductCombobox.svelte';
	import AdminOrderReceipt from '#lib/AdminOrderReceipt.svelte';
	import { readDraft, writeDraft } from '#lib/drafts.js';

	type DraftLine = { key: string; productId: string; quantity: string; unitCost: string; purchaseUrl: string; supplierSku: string };
	const blankLine = (): DraftLine => ({ key: crypto.randomUUID(), productId: '', quantity: '', unitCost: '', purchaseUrl: '', supplierSku: '' });
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminOrders);
	let orders = $state<Order[]>([]); let products = $state<OrderProduct[]>([]); let unplanned = $state<OrderReceipt[]>([]);
	let loaded = $state(false); let loading = $state(true); let failed = $state(false); let busy = $state(false); let storageReady = $state(false);
	let mode = $state<'closed' | 'create' | 'receipt'>('closed'); let command = $state<OrderCommand | null>(null);
	let outcome = $state<'idle' | 'invalid' | 'date' | 'ambiguous' | 'conflict' | 'unknown' | 'recorded'>('idle');
	let invalidInput = $state(''); let invalidMessage = $state('');
	let supplier = $state(''); let reference = $state(''); let placedLocal = $state(''); let offset = $state(''); let additionalCost = $state('0'); let note = $state('');
	let sourceNote = $state(''); let lines = $state<DraftLine[]>([]); let mounted = false; let generation = 0;
	let newOrderTrigger = $state<HTMLButtonElement | null>(null);
	let receiptTrigger = $state<HTMLButtonElement | null>(null);
	let returnMode: 'create' | 'receipt' = 'create';
	let selectedOrderId = $state<string | null>(null);
	let orderReceiptTrigger = $state<HTMLElement | null>(null);
	let plannedRecorded = $state(false);
	// Recorded stock and quantity still on order, per product, for the New order checklist.
	let stock = $state(new Map<string, string>()); let outstanding = $state(new Map<string, string>());
	// An untouched placement time follows the clock until saving, since the admin shops before recording.
	let placedEdited = $state(false);
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const otherCommand = $derived(Boolean(command && (command.kind !== 'create' && (command.kind !== 'receipt' || command.orderId !== null))));
	const frozen = $derived(Boolean(command));
	const offsets = $derived(possibleOsloOffsets(placedLocal));
	// A pending command elsewhere: a planned receipt reopens its sheet here, anything else links to its page.
	// Active parts that are sold out or below their minimum, most urgent first. Ticking one adds its line.
	const needed = $derived(products.filter((item) => stockRank(item, stock.get(item.id)) < 2)
		.sort((a, b) => compareAttention(a, stock.get(a.id), b, stock.get(b.id)) || a.code.localeCompare(b.code)));
	const chosen = $derived(new Set(lines.map((line) => line.productId)));
	// Chips show the most urgent few plus every chosen product; the dialog behind "All" lists them all.
	// A chip used here stays until the page reloads, so releasing it never pulls it from under the pointer.
	const chipLimit = 8;
	let kept = $state(new Set<string>());
	const shownNeeded = $derived(needed.filter((item, index) => index < chipLimit || chosen.has(item.id) || kept.has(item.id)));
	const allNeeded = $derived(needed.every((item) => chosen.has(item.id)));
	// Lines left after ticking, since an untouched blank line gives way to the chosen products.
	const room = $derived(200 - lines.filter((line) => lineFilled(line)).length);
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
	function checked<T>(suffix: string, message: string, parse: () => T): T {
		try { return parse(); }
		catch (error) { invalidInput = `${fieldId}-${suffix}`; invalidMessage = message; throw error; }
	}
	function draftCommand(): OrderCommand {
		// The form keeps an empty line last for the next product; empty lines are not part of the order.
		const filled = lines.filter(lineFilled);
		if (!lines.length || filled.length > 200) throw new Error('invalid');
		const session = admin.credentials();
		let placedAt = ''; let additionalCostNok = '';
		if (mode === 'create') {
			checked('supplier', m.invalid, () => { if (!supplier.trim() || [...supplier.trim()].length > 200) throw new Error('invalid'); });
			placedAt = checked('placed', offsets.length === 2 && !offset ? m.ambiguousDate : m.invalidDate, placedInstant);
			additionalCostNok = checked('extra', m.invalidCost(2), () => cost(additionalCost, 2));
		} else checked('source', m.invalid, () => { if (!sourceNote.trim()) throw new Error('invalid'); });
		const items = (filled.length ? filled : lines.slice(0, 1)).map((line) => {
			const selected = checked(`product-${line.key}`, m.selectProduct, () => product(line.productId));
			const quantity = checked(`qty-${line.key}`, m.invalidQuantity(formatDecimal(selected.stock_step, i18n.locale)), () => validQuantity(line.quantity, selected.stock_step, i18n.locale));
			return { productId: selected.id, quantity, unitCostNok: mode === 'create' ? checked(`cost-${line.key}`, m.invalidCost(6), () => cost(line.unitCost, 6)) : '0',
				purchaseUrl: mode === 'create' ? checked(`url-${line.key}`, i18n.m.adminProducts.invalidLink, () => purchaseUrl(line.purchaseUrl)) : null, supplierSku: line.supplierSku.trim() || null, orderLineId: null };
		});
		if (mode === 'create') {
			return { kind: 'create', userId: session.userId, requestId: crypto.randomUUID(), supplierName: supplier.trim(), placedAt,
				additionalCostNok, supplierReference: reference.trim() || null, note: note.trim() || null,
				items: items.map(({ productId, quantity, unitCostNok, purchaseUrl, supplierSku }) => ({ productId, quantity, unitCostNok, purchaseUrl, supplierSku })) };
		}
		return { kind: 'receipt', userId: session.userId, requestId: crypto.randomUUID(), orderId: null, note: sourceNote.trim(), occurredAt: null,
			items: items.map(({ productId, quantity, orderLineId }) => ({ productId, quantity, orderLineId })) };
	}
	function choose(ids: string[], add: boolean) {
		if (!add) { const drop = new Set(ids); lines = lines.filter((line) => !drop.has(line.productId)); if (!lines.length) lines = [blankLine()]; return; }
		const added = ids.filter((id) => !chosen.has(id)).map((id) => ({ ...blankLine(), productId: id, purchaseUrl: products.find((item) => item.id === id)?.purchase_url ?? '' }));
		if (added.length > room) return;
		lines = [...lines.filter(lineFilled), ...added];
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
		if (!command || otherCommand) restoreDraft();
		draftRestored = true;
		if (page.url.searchParams.has('new')) show('create');
		void updateOrderStorage((storage) => { readOrderCommand(storage); const key = 'ampoteket:order-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); }).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(orderStorageEvent, syncPending); void load();
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(orderStorageEvent, syncPending); };
	});
	// Unsaved input outlives a reload, Back or sign-in round trip (drafts.ts) and
	// returns when the form is opened again. A pending command owns the form, and
	// the draft is left alone meanwhile.
	let draftRestored = $state(false), created = $state(false);
	const draftText = ['supplier', 'reference', 'placedLocal', 'offset', 'additionalCost', 'note', 'sourceNote'] as const;
	const lineText = ['productId', 'quantity', 'unitCost', 'purchaseUrl', 'supplierSku'] as const;
	const lineFilled = (line: DraftLine) => lineText.some((name) => line[name].trim());
	function restoreDraft() {
		const saved = readDraft(admin.session?.user.id, 'order') as Record<string, unknown> | null;
		const text = (value: unknown, names: readonly string[]) => Boolean(value && typeof value === 'object' && names.every(name => typeof (value as Record<string, unknown>)[name] === 'string'));
		if (!saved || !text(saved, draftText) || !Array.isArray(saved.lines) || !saved.lines.length || !saved.lines.every(line => text(line, lineText))) return;
		({ supplier, reference, offset, additionalCost, note, sourceNote } = saved as Record<typeof draftText[number], string>);
		if (saved.placedLocal) { placedLocal = saved.placedLocal as string; placedEdited = true; }
		lines = (saved.lines as Omit<DraftLine, 'key'>[]).map(line => ({ ...blankLine(), ...Object.fromEntries(lineText.map(name => [name, line[name]])) }));
	}
	$effect(() => {
		if (!draftRestored || command) return;
		const fields = { supplier, reference, placedLocal: placedEdited ? placedLocal : '', offset, additionalCost, note, sourceNote, lines: lines.map(({ key, ...line }) => line) };
		const dirty = !created && Boolean(supplier || reference || note || sourceNote || additionalCost !== '0' || fields.placedLocal
			|| fields.lines.some(line => lineText.some(name => line[name])));
		writeDraft(admin.session?.user.id, 'order', dirty ? fields : null);
	});
	async function load() {
		if (admin.status !== 'ready') return;
		const version = ++generation; loading = true; failed = false;
		try {
			const session = admin.credentials();
			const [orderRows, productRows, receiptRows, inventory, onOrder] = await Promise.all([readOrders(session), readOrderProducts(session), readUnplannedReceipts(session), readInventory(session), readOutstandingByProduct(session)]);
			if (mounted && version === generation && session.userId === admin.session?.user.id) {
				orders = orderRows; products = productRows; unplanned = receiptRows; loaded = true;
				stock = new Map(inventory.map((item) => [item.product_id, item.quantity])); outstanding = onOrder;
			}
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(loading || busy)) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	// Choosing a product on the last line opens the next one, so there is no Add line step.
	$effect(() => {
		if (!frozen && lines.length < 200 && lines.at(-1)?.productId) lines.push(blankLine());
	});
	function show(next: 'create' | 'receipt') {
		if (command) return; returnMode = next; mode = next; outcome = 'idle';
		if (!lines.length) lines = [blankLine()];
	}
	function closeForm() {
		if (busy) return;
		if (mode !== 'closed') returnMode = mode;
		mode = 'closed';
		if (page.url.searchParams.has('new')) void goto(i18n.href('/admin/orders'), { shallow: true, replace: true });
	}
	function resumePlanned() {
		if (command?.kind === 'receipt' && command.orderId) selectedOrderId = command.orderId;
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (admin.status !== 'ready' || busy || loading || !storageReady || wrongIdentity || otherCommand || mode === 'closed' || !loaded || failed || (command && command.kind !== mode)) return;
		if (mode === 'create' && !command && !placedEdited) { placedLocal = osloLocal(new Date()); offset = ''; }
		let candidate: OrderCommand; invalidInput = ''; invalidMessage = '';
		try { candidate = command ?? draftCommand(); }
		catch (error) { outcome = error instanceof Error && error.message === 'date' ? 'date' : error instanceof Error && error.message === 'ambiguous' ? 'ambiguous' : 'invalid'; void tick().then(() => document.getElementById(invalidInput)?.focus()); return; }
		busy = true; outcome = 'idle'; let saved: OrderCommand | null = null;
		try {
			const session = admin.credentials();
			saved = await updateOrderStorage((storage) => saveOrderCommand(storage, candidate)); command = saved;
			const result = await runOrderCommand(session, saved);
			await updateOrderStorage((storage) => clearOrderCommand(storage, saved!));
			if (!mounted || session.userId !== admin.session?.user.id) return;
			command = null; outcome = 'recorded';
			if (result.kind === 'create') { created = true; await goto(i18n.href(`/admin/orders/${result.orderId}`)); }
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

{#snippet fieldError(id: string)}
	{#if invalidInput === id}<Field.Error id={`${id}-error`}>{invalidMessage}</Field.Error>{/if}
{/snippet}
<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
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
{:else if pendingNotice === 'other' && command}<Button variant="link" href={i18n.href(orderCommandPath(command))}>{m.resumePending}</Button>
{:else if mode === 'closed' && command && !wrongIdentity}<Button type="button" variant="link" onclick={() => { if (command?.kind === 'create' || (command?.kind === 'receipt' && !command.orderId)) mode = command.kind; }}>{m.resumePending}</Button>{/if}
{#if failed && mode !== 'closed'}<Button type="button" variant="outline" disabled={loading} onclick={load}>{m.retry}</Button>{/if}
{/snippet}
{#if mode === 'closed'}{@render entryStatus()}{/if}
<Dialog.Root open={mode !== 'closed'} onOpenChange={(open) => { if (!open) closeForm(); }}>
	<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined}
		onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
		onEscapeKeydown={(event) => { if (busy) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { event.preventDefault(); void tick().then(() => (returnMode === 'create' ? newOrderTrigger : receiptTrigger)?.focus({ preventScroll: true })); }}>
		<Dialog.Header layout="bar">
			<Dialog.Title id="order-entry-title">{mode === 'create' ? m.newOrder : m.unplannedReceipt}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm" disabled={busy}><Icon icon={XIcon} /><span class="sr-only">{m.closeEntry}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
		<div class={['order-entry-body', sheetBody]} role="region" aria-labelledby="order-entry-title" tabindex="0">
			<AdminAccessGate>
			{#if mode !== 'closed'}{@render entryStatus()}{/if}
			<form id={`${fieldId}-order-form`} class={formLayout} onsubmit={submit}>
			{#if mode === 'create'}
				<Field.Group layout="row">
					<Field.Field width="grow"><Field.Label for={`${fieldId}-supplier`}>{m.supplier}</Field.Label><Input id={`${fieldId}-supplier`} autocapitalize="words" aria-invalid={invalidInput === `${fieldId}-supplier`} aria-describedby={invalidInput === `${fieldId}-supplier` ? `${fieldId}-supplier`.concat('-error') : undefined} required maxlength={200} bind:value={supplier} disabled={frozen || busy} />{@render fieldError(`${fieldId}-supplier`)}</Field.Field>
					<Field.Field width="medium"><Field.Label for={`${fieldId}-reference`}>{m.reference}</Field.Label><Input id={`${fieldId}-reference`} maxlength={2000} bind:value={reference} disabled={frozen || busy} /></Field.Field>
				</Field.Group>
				<Field.Group layout="row">
					<Field.Field width="medium"><Field.Label for={`${fieldId}-placed`}>{m.placedAt}</Field.Label><Input id={`${fieldId}-placed`} aria-invalid={invalidInput === `${fieldId}-placed`} aria-describedby={invalidInput === `${fieldId}-placed` ? `${fieldId}-placed`.concat('-error') : undefined} type="datetime-local" required bind:value={placedLocal} oninput={() => { offset = ''; placedEdited = true; }} disabled={frozen || busy} />{@render fieldError(`${fieldId}-placed`)}</Field.Field>
						{#if offsets.length === 2}<Field.Field width="medium"><Field.Label for={`${fieldId}-offset`}>{m.offset}</Field.Label><NativeSelect.Root id={`${fieldId}-offset`} required bind:value={offset} onchange={() => { placedEdited = true; }} disabled={frozen || busy}><NativeSelect.Option value="">{m.chooseOffset}</NativeSelect.Option><NativeSelect.Option value="+02:00">{m.beforeClockChange}</NativeSelect.Option><NativeSelect.Option value="+01:00">{m.afterClockChange}</NativeSelect.Option></NativeSelect.Root></Field.Field>{/if}
					<Field.Field width="medium"><Field.Label for={`${fieldId}-extra`}>{m.additionalCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-extra`} aria-invalid={invalidInput === `${fieldId}-extra`} aria-describedby={invalidInput === `${fieldId}-extra` ? `${fieldId}-extra`.concat('-error') : undefined} type="text" inputmode="decimal" required bind:value={additionalCost} disabled={frozen || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError(`${fieldId}-extra`)}</Field.Field>
				</Field.Group>
				<Field.Field><Field.Label for={`${fieldId}-note`}>{m.note}</Field.Label><Textarea id={`${fieldId}-note`} rows={2} maxlength={2000} bind:value={note} disabled={frozen || busy} /></Field.Field>
			{:else}
				<Field.Field><Field.Label for={`${fieldId}-source`}>{m.sourceNote}</Field.Label><Textarea id={`${fieldId}-source`} aria-invalid={invalidInput === `${fieldId}-source`} aria-describedby={invalidInput === `${fieldId}-source` ? `${fieldId}-source`.concat('-error') : undefined} rows={2} required maxlength={2000} bind:value={sourceNote} disabled={frozen || busy} />{@render fieldError(`${fieldId}-source`)}</Field.Field>
			{/if}
			{#if mode === 'create' && loading && !loaded}<div class="flex flex-wrap gap-2" aria-hidden="true"><Skeleton class="h-11 w-40" /><Skeleton class="h-11 w-56" /><Skeleton class="h-11 w-48" /></div>
			{:else if mode === 'create' && needed.length}
				<!-- Parts needing ordering, as chips right above the lines they add. -->
				<Field.Set class="gap-2">
					<Field.Legend variant="label">{m.needsOrdering}</Field.Legend>
					<div class="flex flex-wrap gap-2">
						<Toggle variant="outline" size="sm" pressed={allNeeded} disabled={frozen || busy || (!allNeeded && needed.filter((item) => !chosen.has(item.id)).length > room)} onPressedChange={(pressed) => choose(needed.map((item) => item.id), pressed)}>{m.selectAll}</Toggle>
						{#each shownNeeded as item (item.id)}
							{@const quantity = stock.get(item.id)!}
							{@const onOrder = outstanding.get(item.id)}
							{@const soldOut = compareDecimals(quantity, '0') <= 0}
							<Toggle variant="outline" size="sm" class="max-w-full justify-start gap-2 text-left" pressed={chosen.has(item.id)} disabled={frozen || busy || (!chosen.has(item.id) && room < 1)} onPressedChange={(pressed) => { kept = new Set([...kept, item.id]); choose([item.id], pressed); }}>
								{#if soldOut}<Icon icon={XCircleIcon} class="text-destructive" />{:else}<span class="rounded-sm bg-warning p-0.5 text-on-warning"><Icon icon={WarningIcon} class="size-3.5" /></span>{/if}
								<span class="sr-only">{!soldOut ? i18n.m.shop.stockLow : compareDecimals(quantity, '0') < 0 ? i18n.m.shop.stockNegative : i18n.m.shop.stockZero}:</span>
								<span class={nameWrap}>{productName(item, i18n.locale)}</span>
								<span class="font-mono tabular-nums">{i18n.m.shop.quantity(formatDecimal(quantity, i18n.locale), unitLabel(item.unit_code, i18n.locale, quantity))}</span>
								{#if onOrder}<span class="inline-flex items-center gap-1 font-mono tabular-nums text-muted-foreground"><Icon icon={TruckIcon} /><span aria-hidden="true">{formatDecimal(onOrder, i18n.locale)}</span><span class="sr-only">{m.onOrder(`${formatDecimal(onOrder, i18n.locale)} ${unitLabel(item.unit_code, i18n.locale, onOrder)}`)}</span></span>{/if}
							</Toggle>
						{/each}
						{#if needed.length > chipLimit}
							<Dialog.Root>
								<Dialog.Trigger class={toggleVariants({ variant: 'outline', size: 'sm' })} disabled={frozen || busy}><Icon icon={ListBulletsIcon} />{m.allNeeded(needed.length)}</Dialog.Trigger>
								<Dialog.Content preventScroll={false} aria-describedby={undefined} class="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
									<Dialog.Header layout="bar">
										<Dialog.Title id={`${fieldId}-needed-title`}>{m.needsOrdering}</Dialog.Title>
										<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} /><span class="sr-only">{m.closeNeeded}</span></Button>{/snippet}</Dialog.Close>
									</Dialog.Header>
									<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named dialog body supports native keyboard scrolling.) -->
									<div class={sheetBody} role="region" aria-labelledby={`${fieldId}-needed-title`} tabindex="0">
										<Field.Field orientation="horizontal" class="gap-3 pb-4">
											<Checkbox id={`${fieldId}-needed-all`} checked={allNeeded} indeterminate={!allNeeded && needed.some((item) => chosen.has(item.id))} disabled={frozen || busy || (!allNeeded && needed.filter((item) => !chosen.has(item.id)).length > room)} onCheckedChange={(checked) => choose(needed.map((item) => item.id), checked === true)} />
											<Field.Label for={`${fieldId}-needed-all`} class="cursor-pointer">{m.selectAll}</Field.Label>
										</Field.Field>
										{#each needed as item (item.id)}
											{@const onOrder = outstanding.get(item.id)}
											<Separator />
											<Field.Field orientation="horizontal" class="min-w-0 gap-3 py-4">
												<Checkbox id={`${fieldId}-needed-${item.id}`} checked={chosen.has(item.id)} disabled={frozen || busy || (!chosen.has(item.id) && room < 1)} onCheckedChange={(checked) => choose([item.id], checked === true)} />
												<div class="min-w-0">
													<Field.Label for={`${fieldId}-needed-${item.id}`} class={['cursor-pointer', nameWrap]}>{productName(item, i18n.locale)}</Field.Label>
													<Field.Description class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
														<span class={codeText}>{item.code}</span>
														<StockBadge quantity={stock.get(item.id)!} unit={unitLabel(item.unit_code, i18n.locale)} minimum={item.minimum_stock} compact />
														{#if onOrder}<Badge variant="outline">{m.onOrder(`${formatDecimal(onOrder, i18n.locale)} ${unitLabel(item.unit_code, i18n.locale, onOrder)}`)}</Badge>{/if}
													</Field.Description>
												</div>
											</Field.Field>
										{/each}
									</div>
									<Dialog.Footer variant="sheet">
										<Dialog.Close>{#snippet child({ props })}<Button {...props}>{m.doneNeeded}</Button>{/snippet}</Dialog.Close>
									</Dialog.Footer>
								</Dialog.Content>
							</Dialog.Root>
						{/if}
					</div>
				</Field.Set>
			{/if}
			<div class="space-y-6">
				{#each lines as line, index (line.key)}
					{@const unit = unitLabel(products.find((item) => item.id === line.productId)?.unit_code, i18n.locale)}
					<fieldset class="space-y-3">
						<legend id={`${fieldId}-line-${line.key}`} class="font-semibold">{m.lineNumber(index + 1)}</legend>
						<Separator />
						<Field.Group layout="row">
							<OrderProductCombobox id={`${fieldId}-product-${line.key}`} error={invalidInput === `${fieldId}-product-${line.key}` ? invalidMessage : undefined} {products} bind:value={line.productId} oncreated={mode === 'create' ? (item) => { products = [...products.filter((value) => value.id !== item.id), item].sort((a, b) => a.code.localeCompare(b.code)); line.purchaseUrl ||= item.purchase_url ?? ''; } : undefined} disabled={frozen || busy || loading} />
							<Field.Field width="short"><Field.Label for={`${fieldId}-qty-${line.key}`}>{m.quantity}{#if unit}<span class="sr-only">{` (${unit})`}</span>{/if}</Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-qty-${line.key}`} aria-invalid={invalidInput === `${fieldId}-qty-${line.key}`} aria-describedby={invalidInput === `${fieldId}-qty-${line.key}` ? `${fieldId}-qty-${line.key}`.concat('-error') : undefined} type="text" inputmode="decimal" required={index === 0 || lineFilled(line)} bind:value={line.quantity} disabled={frozen || busy} />{#if unit}<InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unit}</InputGroup.Text></InputGroup.Addon>{/if}</InputGroup.Root>{@render fieldError(`${fieldId}-qty-${line.key}`)}</Field.Field>
							{#if mode === 'create'}<Field.Field width="medium"><Field.Label for={`${fieldId}-cost-${line.key}`}>{m.unitCost} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-cost-${line.key}`} aria-invalid={invalidInput === `${fieldId}-cost-${line.key}`} aria-describedby={invalidInput === `${fieldId}-cost-${line.key}` ? `${fieldId}-cost-${line.key}`.concat('-error') : undefined} type="text" inputmode="decimal" required={index === 0 || lineFilled(line)} bind:value={line.unitCost} disabled={frozen || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError(`${fieldId}-cost-${line.key}`)}</Field.Field>{/if}
						</Field.Group>
						{#if mode === 'create'}<Field.Group layout="row"><Field.Field width="grow"><Field.Label for={`${fieldId}-url-${line.key}`}>{m.purchaseUrl}</Field.Label><Input id={`${fieldId}-url-${line.key}`} aria-invalid={invalidInput === `${fieldId}-url-${line.key}`} aria-describedby={invalidInput === `${fieldId}-url-${line.key}` ? `${fieldId}-url-${line.key}`.concat('-error') : undefined} type="url" autocapitalize="none" enterkeyhint="go" maxlength={2000} bind:value={line.purchaseUrl} disabled={frozen || busy} />{#if openable(line.purchaseUrl)}<a class="w-fit text-sm" href={line.purchaseUrl.trim()} target="_blank" rel="noopener noreferrer" aria-describedby={`${fieldId}-line-${line.key}`}>{m.openPurchaseUrl}</a>{/if}{@render fieldError(`${fieldId}-url-${line.key}`)}</Field.Field><Field.Field width="medium"><Field.Label for={`${fieldId}-sku-${line.key}`}>{m.supplierSku}</Field.Label><Input id={`${fieldId}-sku-${line.key}`} maxlength={2000} bind:value={line.supplierSku} disabled={frozen || busy} /></Field.Field></Field.Group>{/if}
						{#if !frozen && lines.length > 1 && (line.productId || index < lines.length - 1)}<Button type="button" variant="ghost" onclick={() => lines = lines.filter((item) => item.key !== line.key)} disabled={busy}>{m.removeLine}</Button>{/if}
					</fieldset>
				{/each}
			</div>
			</form>
			</AdminAccessGate>
		</div>
		<Dialog.Footer variant="sheet">
			<Button type="submit" form={`${fieldId}-order-form`} disabled={admin.status !== 'ready' || !storageReady || !loaded || loading || failed || busy || wrongIdentity || otherCommand}><ButtonLabel pending={busy} pendingLabel={m.working} label={frozen ? m.retrySame : mode === 'create' ? m.recordOrder : m.recordReceipt} reserveLabels={[m.retrySame, m.recordOrder, m.recordReceipt]} /></Button>
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
	<Item.Group>{#each unplanned as receipt, index (receipt.id)}{#if index > 0}<Item.Separator />{/if}<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0"><Item.Title class={itemTitle}>{receipt.note ?? m.unplannedHistory}</Item.Title><Item.Description>{formatCountedAt(receipt.occurredAt, i18n.locale)}</Item.Description><ul class="space-y-1 text-sm">{#each receipt.movements as movement (movement.id)}{@const product = products.find((item) => item.id === movement.productId)}<li class={nameWrap}>{#if product}<span class={codeText}>{product.code}</span> {productName(product, i18n.locale)}{:else}{movement.productId}{/if} · <span class="font-mono">{formatDecimal(movement.quantityDelta, i18n.locale)} {unitLabel(product?.unit_code, i18n.locale, movement.quantityDelta)}</span></li>{/each}</ul></Item.Content></Item.Root>{/each}</Item.Group>
</section>
{/if}
