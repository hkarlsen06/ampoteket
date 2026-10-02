<script lang="ts">
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { productName } from '#lib/catalog.js';
	import { onMount, tick, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { compareDecimals, validQuantity } from '#lib/decimal.js';
	import { formatDecimal, unitLabel } from '#lib/format.js';
	import { clearOrderCommand, orderCommandPath, orderRejection, orderStorageEvent, readOrderCommand, readOrderDetail, runOrderCommand, saveOrderCommand, updateOrderStorage, type OrderCommand, type OrderDetail, type OrderLine } from '#lib/admin-orders.js';
	import { productCodeFromQr } from '#lib/scanner/payload.js';
	import { readDraft, writeDraft } from '#lib/drafts.js';
	import type { CameraSession, CameraState } from '#lib/scanner/session.js';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import CameraFrame from '#lib/CameraFrame.svelte';
	import LocationChips from '#lib/LocationChips.svelte';
	import { readAdminProducts, type AdminProduct } from '#lib/admin-products.js';
	import { readShelfTopology, type ShelfTopology } from '#lib/shelf-map.js';
	import { codeText, nameWrap, sheetBody } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { orderId, returnFocus, onclose, onrecorded }: {
		orderId: string;
		returnFocus?: HTMLElement | null;
		onclose: () => void;
		onrecorded: () => void | Promise<void>;
	} = $props();
	const i18n = getI18n();
	const admin = getAdminContext();
	const m = $derived(i18n.m.adminOrders);
	const id = $props.id();
	let detail = $state<OrderDetail | null>(null);
	// Where each product goes, so a delivery can be shelved from this sheet. Optional: a failed read just omits it.
	let placement = $state<{ products: Map<string, AdminProduct>; shelf: ShelfTopology } | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let busy = $state(false);
	let storageReady = $state(false);
	let command = $state<OrderCommand | null>(null);
	let quantities = $state<Record<string, string>>({});
	let invalidLine = $state(''); let invalidMessage = $state('');
	let manual = $state<Set<string>>(new Set());
	let outcome = $state<'idle' | 'invalid' | 'unknown' | 'conflict'>('idle');
	let scanOpen = $state(false);
	let cameraState = $state<CameraState>('closed');
	let scanResult = $state<'idle' | 'invalid' | 'missing' | 'match'>('idle');
	let scanCode = $state<string | null>(null);
	let video: HTMLVideoElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let cameraSession: CameraSession | null = null;
	let cameraOperation = 0;
	let mounted = false;
	let generation = 0;
	const pendingHere = $derived(command?.kind === 'receipt' && command.orderId === orderId);
	const products = $derived(new Map(detail?.products.map((product) => [product.id, product]) ?? []));
	const openLines = $derived(detail?.lines.filter((line) => compareDecimals(line.outstandingQuantity, '0') > 0) ?? []);
	const reviewLines = $derived(detail?.lines.filter((line) => compareDecimals(line.outstandingQuantity, '0') > 0 || Boolean(quantities[line.id]?.trim())) ?? []);
	const matchingLines = $derived(openLines.filter((line) => products.get(line.productId)?.code === scanCode));
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const selectedCount = $derived(reviewLines.filter((line) => quantities[line.id]?.trim()).length);

	function full(line: OrderLine) { return !manual.has(line.id) && quantities[line.id] === line.outstandingQuantity; }
	function chooseFull(line: OrderLine, checked: boolean) {
		manual = new Set([...manual].filter((value) => value !== line.id));
		quantities = { ...quantities, [line.id]: checked ? line.outstandingQuantity : '' };
	}
	function override(line: OrderLine) {
		manual = new Set([...manual, line.id]);
		quantities = { ...quantities, [line.id]: quantities[line.id] ?? '' };
	}
	function syncPending() {
		if (busy) return;
		try {
			command = readOrderCommand(localStorage);
			if (command?.kind === 'receipt' && command.orderId === orderId) {
				quantities = Object.fromEntries(command.items.map((item) => [item.orderLineId!, item.quantity]));
				outcome = 'unknown';
			}
		} catch { storageReady = false; }
	}
	onMount(() => {
		mounted = true;
		syncPending();
		// Ticks and amounts outlive closing the sheet, a reload or a sign-in round
		// trip (drafts.ts); lines received in full meanwhile are dropped on load.
		const saved = pendingHere ? null : readDraft(admin.session?.user.id, `receipt:${orderId}`) as { quantities?: unknown; manual?: unknown } | null;
		const texts = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
		if (saved?.quantities && typeof saved.quantities === 'object' && texts(Object.values(saved.quantities)) && texts(saved.manual)) {
			quantities = saved.quantities as Record<string, string>; manual = new Set(saved.manual as string[]); restoredDraft = true;
		}
		draftLoaded = true;
		void updateOrderStorage((storage) => {
			readOrderCommand(storage);
			const key = 'ampoteket:order-storage-check';
			storage.setItem(key, '1');
			if (storage.getItem(key) !== '1') throw new Error();
			storage.removeItem(key);
		}).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending);
		window.addEventListener(orderStorageEvent, syncPending);
		const hide = () => { if (document.hidden) { cameraSession?.interrupt(); cameraState = 'interrupted'; } };
		document.addEventListener('visibilitychange', hide);
		void load();
		return () => {
			mounted = false; generation++; stopCamera();
			window.removeEventListener('storage', syncPending);
			window.removeEventListener(orderStorageEvent, syncPending);
			document.removeEventListener('visibilitychange', hide);
		};
	});
	async function load() {
		if (admin.status !== 'ready') return;
		const version = ++generation;
		loading = true; failed = false;
		try {
			const session = admin.credentials();
			const result = await readOrderDetail(session, orderId);
			if (mounted && version === generation && admin.session?.user.id === session.userId) {
				detail = result;
				const ids = result.products.map((product) => product.id);
				if (ids.length) void Promise.all([readAdminProducts(session, fetch, ids), readShelfTopology(session.config)]).then(([rows, shelf]) => {
					if (mounted && version === generation) placement = { products: new Map(rows.map((row) => [row.id, row])), shelf };
				}).catch(() => {});
				if (restoredDraft) {
					restoredDraft = false;
					const open = new Set(result.lines.filter(line => compareDecimals(line.outstandingQuantity, '0') > 0).map(line => line.id));
					quantities = Object.fromEntries(Object.entries(quantities).filter(([line]) => open.has(line)));
				}
				// Keep a selected amount visible when another receipt changes what remains.
				manual = new Set([...manual, ...result.lines.filter(line => quantities[line.id]?.trim() && quantities[line.id] !== line.outstandingQuantity).map(line => line.id)]);
			}
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	let draftLoaded = $state(false), restoredDraft = false;
	$effect(() => {
		// Another pending command leaves this draft alone; this sheet is inert meanwhile.
		if (!draftLoaded || command) return;
		const dirty = Object.values(quantities).some(value => value.trim());
		writeDraft(admin.session?.user.id, `receipt:${orderId}`, dirty ? { quantities: $state.snapshot(quantities), manual: [...manual] } : null);
	});
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !loading && !busy) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (admin.status !== 'ready' || !detail?.order || busy || loading || failed || !storageReady || wrongIdentity || (command && !pendingHere)) return;
		let candidate: OrderCommand; invalidLine = ''; invalidMessage = '';
		try {
			if (command) candidate = command;
			else {
				const items = reviewLines.flatMap((line) => {
					const raw = quantities[line.id]?.trim();
					if (!raw) return [];
					const product = products.get(line.productId);
					if (!product) throw new Error('Missing product');
					let quantity: string;
					try { quantity = validQuantity(raw, product.stock_step, i18n.locale); }
					catch (error) { invalidLine = line.id; invalidMessage = m.invalidQuantity(formatDecimal(product.stock_step, i18n.locale)); throw error; }
					if (compareDecimals(quantity, line.outstandingQuantity) > 0) {
						invalidLine = line.id; invalidMessage = m.exceedsOutstanding(formatDecimal(line.outstandingQuantity, i18n.locale), unitLabel(product.unit_code, i18n.locale, line.outstandingQuantity));
						throw new Error('Too much');
					}
					return [{ productId: line.productId, orderLineId: line.id, quantity }];
				});
				if (!items.length) throw new Error('No selection');
				candidate = { kind: 'receipt', userId: admin.credentials().userId, requestId: crypto.randomUUID(), orderId, items, note: null, occurredAt: null };
			}
		} catch {
			outcome = 'invalid';
			if (invalidLine) { manual = new Set([...manual, invalidLine]); void tick().then(() => document.getElementById(`${id}-qty-${invalidLine}`)?.focus()); }
			return;
		}
		busy = true; outcome = 'idle';
		let saved: OrderCommand | null = null;
		let recorded = false;
		try {
			const session = admin.credentials();
			saved = await updateOrderStorage((storage) => saveOrderCommand(storage, candidate));
			command = saved;
			await runOrderCommand(session, saved);
			await updateOrderStorage((storage) => clearOrderCommand(storage, saved!));
			recorded = true;
		} catch (error) {
			const rejected = saved ? orderRejection(error) : null;
			if (saved && rejected) {
				try {
					await updateOrderStorage((storage) => clearOrderCommand(storage, saved!));
					if (mounted) { command = null; outcome = rejected === 'stale' ? 'conflict' : 'invalid'; await load(); }
				} catch { if (mounted) outcome = 'unknown'; }
			} else if (mounted) outcome = saved ? 'unknown' : 'invalid';
			await admin.permissionFailure(error);
		} finally { if (mounted) { busy = false; syncPending(); } }
		if (recorded && mounted && admin.session?.user.id === candidate.userId) {
			// onclose() destroys this sheet before an effect could drop the draft.
			command = null; quantities = {}; writeDraft(candidate.userId, `receipt:${orderId}`, null);
			onclose();
			try { await onrecorded(); } catch (error) { await admin.permissionFailure(error); }
		}
	}
	function stopCamera() {
		cameraOperation++; cameraSession?.stop(); cameraSession = null; cameraState = 'closed'; scanCode = null; scanResult = 'idle';
	}
	async function startCamera() {
		scanCode = null; scanResult = 'idle'; cameraState = 'starting';
		const current = ++cameraOperation;
		await tick();
		try {
			const { CameraSession } = await import('#lib/scanner/session.js');
			if (!mounted || !scanOpen || current !== cameraOperation || !video || !canvas) return;
			cameraSession = new CameraSession(video, canvas, {
				state: (next) => { if (current === cameraOperation) cameraState = next; },
				duplicate: () => {},
				scan: (payload) => { if (current === cameraOperation) checkCode(productCodeFromQr(payload)); }
			});
			await cameraSession.start();
		} catch { if (current === cameraOperation) cameraState = 'decoder'; }
	}
	function checkCode(code: string | null) {
		cameraSession?.pause(); scanCode = code;
		scanResult = !code ? 'invalid' : openLines.some((line) => products.get(line.productId)?.code === code) ? 'match' : 'missing';
	}
	function scanNext() { scanCode = null; scanResult = 'idle'; cameraSession?.rearm(); cameraSession?.resume(); }
	function cameraMessage() {
		if (cameraState === 'denied') return m.cameraDenied;
		if (cameraState === 'interrupted') return m.cameraInterrupted;
		if (cameraState === 'unavailable' || cameraState === 'decoder') return m.cameraUnavailable;
		return i18n.m.scanner.camera[cameraState];
	}
</script>

{#snippet location(productId: string)}
	{@const item = placement?.products.get(productId)}
	{@const bin = item && placement?.shelf.bins.find((value) => value.id === item.bin_id)}
	{@const cabinet = bin && placement?.shelf.cabinets.find((value) => value.id === bin.cabinet_id)}
	{#if bin && cabinet}<div class="mt-1"><LocationChips outerRow={cabinet.outer_row} outerCol={cabinet.outer_col} innerRow={bin.inner_row} innerCol={bin.inner_col} rowSpan={bin.row_span} colSpan={bin.col_span} plain /></div>
	{:else if item?.location_note}<div class="mt-1"><LocationChips note={item.location_note} plain /></div>
	{:else if item}<p class="mt-1 text-sm text-muted-foreground">{i18n.m.adminProducts.unplaced}</p>{/if}
{/snippet}

<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<Dialog.Root open={true} onOpenChange={(open) => { if (!open && !busy) onclose(); }}>
	<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined}
		onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
		onEscapeKeydown={(event) => { if (busy) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { event.preventDefault(); void tick().then(() => returnFocus?.focus({ preventScroll: true })); }}>
		<Dialog.Header layout="bar">
			<Dialog.Title id={`${id}-title`}>{m.receiveHeading}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm" disabled={busy}><Icon icon={XIcon} /><span class="sr-only">{m.closeReceipt}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
		<div class={sheetBody} role="region" aria-labelledby={`${id}-title`} tabindex="0">
			<AdminAccessGate>
			{#if detail?.order}<p class={[nameWrap, 'mb-4 font-medium']}>{detail.order.supplierName}</p>{/if}
			{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>{/if}
			{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
			{:else if command && !pendingHere}<Alert.Message appearance="inline" role="status">{m.pendingElsewhere}</Alert.Message><Button variant="link" href={i18n.href(orderCommandPath(command))}>{m.resumePending}</Button>{/if}
			{#if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknown}</Alert.Message>
			{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalid}</Alert.Message>
			{:else if outcome === 'conflict'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.conflict}</Alert.Message>{/if}
			{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load} disabled={loading}>{m.retry}</Button>{/if}
			{#if loading && !detail}<span class="sr-only" role="status">{m.loading}</span><div class="space-y-4" aria-busy="true" aria-hidden="true"><Skeleton class="h-20 w-full" /><Skeleton class="h-20 w-full" /></div>
			{:else if detail?.order}
				{#if reviewLines.length}
					{#if !pendingHere}<Collapsible.Root open={scanOpen} onOpenChange={(open) => { scanOpen = open; if (open) void startCamera(); else stopCamera(); }}>
						<Collapsible.Trigger>{#snippet child({ props })}<Button {...props} variant="outline" class="no-js:hidden"><Icon icon={QrCodeIcon} />{m.scanProduct}</Button>{/snippet}</Collapsible.Trigger>
						<Collapsible.Content class="mt-3 space-y-3">
							<CameraFrame bind:video bind:canvas />
							<p class="text-sm text-muted-foreground" role="status">{cameraMessage()}</p>
							{#if !['starting', 'scanning'].includes(cameraState)}<Button type="button" variant="outline" size="sm" onclick={startCamera}>{i18n.m.scanner.retryCamera}</Button>{/if}
							<div aria-live="polite">
								{#if scanResult === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanInvalid}</Alert.Message>
								{:else if scanResult === 'missing'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanNotOrdered(scanCode!)}</Alert.Message>
								{:else if scanResult === 'match'}<span class="sr-only">{m.scanMatch(scanCode!)} {matchingLines.map((line) => m.lineNumber(line.lineNumber)).join(', ')}</span>{/if}
								{#if scanResult !== 'idle'}<Button type="button" variant="ghost" size="sm" onclick={scanNext}>{m.scanNext}</Button>{/if}
							</div>
						</Collapsible.Content>
					</Collapsible.Root>{/if}
					<form id={`${id}-form`} class="mt-5" onsubmit={submit}>
						{#each reviewLines as line, index (line.id)}
							{@const product = products.get(line.productId)}
							<!-- A matching scan marks its line with the shelf map's yellow "current" outline over a dark edge. -->
							{@const scanned = scanResult === 'match' && product?.code === scanCode}
							{#if index > 0}<Separator />{/if}
							<div class={['-mx-2 grid gap-2 rounded-md px-2 py-4', index === 0 && 'pt-0', scanned && 'outline-3 outline-offset-2 outline-warning ring-2 ring-[var(--focus-contrast)]']}>
								<div class="flex flex-wrap items-center justify-between gap-2">
									<Field.Field orientation="horizontal" class="min-w-0 flex-1 basis-56 gap-3">
										<Checkbox id={`${id}-full-${line.id}`} checked={full(line)} onCheckedChange={(checked) => chooseFull(line, checked === true)} disabled={busy || Boolean(command)} />
										<div class="min-w-0"><Field.Label for={`${id}-full-${line.id}`} class={['cursor-pointer', nameWrap]}><!-- One span: the label is a flex row, so loose text would become columns. --><span>{#if product}<span class={codeText}>{product.code}</span>: {productName(product, i18n.locale)}{:else}{line.productId}{/if}</span></Field.Label><Field.Description>{m.lineNumber(line.lineNumber)} · {m.outstanding} <span class="font-mono">{formatDecimal(line.outstandingQuantity, i18n.locale)} {unitLabel(product?.unit_code, i18n.locale, line.outstandingQuantity)}</span></Field.Description>{@render location(line.productId)}</div>
									</Field.Field>
									{#if !manual.has(line.id)}<Button type="button" variant="ghost" size="sm" onclick={() => override(line)} disabled={busy || Boolean(command)}>{m.differentQuantity}</Button>{/if}
								</div>
								{#if manual.has(line.id)}<Field.Field width="short"><Field.Label for={`${id}-qty-${line.id}`}>{m.receivedQuantity}{#if product}<span class="sr-only">{` (${unitLabel(product.unit_code, i18n.locale)})`}</span>{/if}</Field.Label><InputGroup.Root><InputGroup.Input id={`${id}-qty-${line.id}`} aria-invalid={invalidLine === line.id} aria-describedby={invalidLine === line.id ? `${id}-qty-${line.id}-error` : undefined} type="text" inputmode="decimal" autocomplete="off" bind:value={quantities[line.id]} disabled={busy || Boolean(command)} />{#if product}<InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(product.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon>{/if}</InputGroup.Root>{#if invalidLine === line.id}<Field.Error id={`${id}-qty-${line.id}-error`}>{invalidMessage}</Field.Error>{/if}</Field.Field>{/if}
							</div>
						{/each}
					</form>
				{:else}<Empty.Root><Empty.Description>{m.noOutstanding}</Empty.Description></Empty.Root>{/if}
			{:else if !loading && !failed}<Empty.Root><Empty.Description>{m.missing}</Empty.Description></Empty.Root>
			{/if}
			</AdminAccessGate>
		</div>
		{#if reviewLines.length}
			<Dialog.Footer variant="sheet">
				<Button type="submit" form={`${id}-form`} disabled={admin.status !== 'ready' || busy || loading || failed || !storageReady || wrongIdentity || Boolean(command && !pendingHere) || (!pendingHere && selectedCount === 0)}><ButtonLabel pending={busy} pendingLabel={m.working} label={pendingHere ? m.retrySame : m.confirmReceived} reserveLabels={[m.retrySame, m.confirmReceived]} /></Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
