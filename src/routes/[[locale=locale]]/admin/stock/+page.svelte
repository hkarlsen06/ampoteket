<script lang="ts">
	import { untrack, onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { countDifference, validCountQuantity } from '$lib/admin-counts';
	import { compareDecimals } from '$lib/decimal';
	import { clearStockCommand, needsRecount, readStockCommand, readStockDetail, readStockProducts, runStockCommand, saveStockCommand, stockQuantity, stockRejection, stockStorageEvent, updateStockStorage, type StockCommand, type StockDetail, type StockProduct } from '$lib/admin-stock';
	import { formatCountedAt, formatDecimal, unitLabel } from '$lib/format';
	import { formActions, formLayout, formStatus, itemTitle, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import StockBadge from '$lib/StockBadge.svelte';
	import * as Item from '$lib/components/ui/item';
	import OrderProductCombobox from '$lib/OrderProductCombobox.svelte';
	import AdminProductScanner from '$lib/AdminProductScanner.svelte';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Separator } from '$lib/components/ui/separator';
	import { readDraft, writeDraft } from '$lib/drafts';

	const fieldId = $props.id();
	const i18n = getI18n(), admin = getAdminContext();
	const m = $derived(i18n.m.adminStock);
	let products = $state<StockProduct[]>([]), selected = $state('');
	let detail = $state<StockDetail | null>(null), loaded = $state(false), failed = $state(false), loading = $state(true);
	let kind = $state<'withdraw' | 'adjust' | 'correct'>('withdraw'), movementId = $state(''), quantity = $state(''), counted = $state(''), reason = $state('');
	let command = $state<StockCommand | null>(null), storageReady = $state(false), busy = $state(false), reviewNeeded = $state(false), paused = $state(false);
	let outcome = $state<'idle' | 'invalid' | 'unknown' | 'stale' | 'recount' | 'saved'>('idle');
	let invalidField = $state(''), invalidMessage = $state('');
	let mounted = false, generation = 0;
	const product = $derived(products.find(item => item.id === selected));
	const original = $derived(detail?.movements.find(item => item.id === movementId));
	const recount = $derived(command ? command.counted !== null : Boolean(detail && movementId && needsRecount(detail, movementId)));
	const earlier = $derived(detail?.movements.filter(item => item.corrects === movementId) ?? []);
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const otherProduct = $derived(Boolean(command && command.productId !== selected));

	function syncPending() {
		if (busy) return;
		try {
			command = readStockCommand(localStorage);
			if (command) {
				selected = command.productId; kind = command.kind; movementId = command.movementId ?? '';
				quantity = command.quantity; counted = command.counted ?? ''; reason = command.reason; paused = command.counted !== null; outcome = 'unknown';
			}
		} catch { storageReady = false; }
	}
	onMount(() => {
		mounted = true; selected = page.url.searchParams.get('product') ?? ''; syncPending();
		if (!command) restoreDraft();
		draftLoaded = true;
		void updateStockStorage(storage => { readStockCommand(storage); const key = 'ampoteket:stock-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); }).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(stockStorageEvent, syncPending); void load();
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(stockStorageEvent, syncPending); };
	});
	async function load() {
		if (admin.status !== 'ready') return;
		const version = ++generation, session = admin.credentials(); loading = true; failed = false;
		try {
			const result = await readStockProducts(session);
			if (!mounted || version !== generation || admin.session?.user.id !== session.userId) return;
			products = result; loaded = true;
			if (selected && result.some(item => item.id === selected)) {
				const next = await readStockDetail(session, selected);
				if (!mounted || version !== generation || admin.session?.user.id !== session.userId) return;
				const base = detail?.stock.revision ?? draftRevision; draftRevision = null;
				if (!command && base && kind === 'correct' && movementId && (quantity || reason) && base !== next.stock.revision) { reviewNeeded = true; outcome = 'stale'; }
				detail = next;
			}
			else { selected = ''; detail = null; }
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	// Unsaved input outlives a reload, Back or sign-in round trip (drafts.ts). A
	// restored correction keeps the stock revision it was typed against and any
	// review still owed.
	let draftLoaded = $state(false), draftRevision: string | null = null;
	function restoreDraft() {
		const saved = readDraft(admin.session?.user.id, 'stock') as Record<string, unknown> | null;
		if (!saved || (selected && saved.selected !== selected) || !['withdraw', 'adjust', 'correct'].includes(saved.kind as string)
			|| !['selected', 'movementId', 'quantity', 'counted', 'reason'].every(name => typeof saved[name] === 'string') || typeof saved.paused !== 'boolean') return;
		({ selected, movementId, quantity, counted, reason, paused } = saved as { selected: string; movementId: string; quantity: string; counted: string; reason: string; paused: boolean });
		kind = saved.kind as typeof kind; draftRevision = typeof saved.revision === 'string' ? saved.revision : null;
		// A correction whose baseline is unknown is reviewed before it can be saved.
		if (saved.reviewNeeded === true || (kind === 'correct' && movementId && !draftRevision)) { reviewNeeded = true; paused = false; outcome = 'stale'; }
	}
	$effect(() => {
		// A pending command owns the form; a draft is left alone meanwhile.
		if (!draftLoaded || command) return;
		const dirty = Boolean(quantity || counted || reason);
		writeDraft(admin.session?.user.id, 'stock', dirty ? { selected, kind, movementId, quantity, counted, reason, paused, reviewNeeded, revision: detail?.stock.revision ?? draftRevision } : null);
	});
	async function choose(productId: string) {
		if (command || busy || admin.status !== 'ready') return;
		selected = productId; detail = null; movementId = ''; paused = false; outcome = 'idle'; reviewNeeded = false;
		invalidField = ''; invalidMessage = '';
		if (!productId) return;
		const version = ++generation, session = admin.credentials(); loading = true; failed = false;
		try { const result = await readStockDetail(session, productId); if (mounted && version === generation && session.userId === admin.session?.user.id) detail = result; }
		catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
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
	async function rejectField(field: string, message: string) {
		invalidField = field; invalidMessage = message;
		await tick();
		document.getElementById(`${fieldId}-${field}`)?.focus();
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || loading || admin.status !== 'ready' || !storageReady || wrongIdentity || otherProduct || !product || !detail || failed || reviewNeeded || (!command && kind === 'correct' && recount && !paused)) return;
		invalidField = ''; invalidMessage = '';
		let nextQuantity = quantity, nextCounted: string | null = null;
		if (!command) {
			try { nextQuantity = stockQuantity(quantity, product.stock_step, kind !== 'withdraw', i18n.locale); }
			catch { await rejectField('quantity', m.invalidQuantity(formatDecimal(product.stock_step, i18n.locale), kind !== 'withdraw')); return; }
			if (kind === 'correct' && recount) {
				try { nextCounted = validCountQuantity(counted, product.stock_step, i18n.locale); }
				catch { await rejectField('counted', i18n.m.adminCounts.invalidQuantity(formatDecimal(product.stock_step, i18n.locale))); return; }
			}
			if (!reason.trim()) { await rejectField('reason', m.reasonRequired); return; }
		}
		busy = true; outcome = 'idle'; let frozen: StockCommand | null = null;
		try {
			const session = admin.credentials();
			const candidate: StockCommand = command ?? {
				userId: session.userId, requestId: crypto.randomUUID(), kind, productId: product.id,
				quantity: nextQuantity, reason: reason.trim(),
				movementId: kind === 'correct' ? original?.id ?? null : null, revision: kind === 'correct' ? detail.stock.revision : null,
				counted: nextCounted
			};
			if (kind === 'correct' && !original || !candidate.reason || [...candidate.reason].length > 2000) throw new Error('Invalid stock form');
			frozen = await updateStockStorage(storage => saveStockCommand(storage, candidate)); command = frozen;
			await runStockCommand(session, frozen);
			await updateStockStorage(storage => clearStockCommand(storage, frozen!)); command = null;
			if (mounted) { outcome = 'saved'; quantity = ''; counted = ''; reason = ''; movementId = ''; paused = false; await load(); }
		} catch (error) {
			const rejection = frozen ? stockRejection(error) : null;
			if (rejection && frozen) {
				try { await updateStockStorage(storage => clearStockCommand(storage, frozen!)); command = null; }
				catch { outcome = 'unknown'; await admin.permissionFailure(error); return; }
				if (rejection === 'stale' || rejection === 'recount') { reviewNeeded = true; void load(); }
				outcome = rejection === 'invalid' ? 'invalid' : rejection;
			} else outcome = frozen ? 'unknown' : 'invalid';
			await admin.permissionFailure(error);
		} finally { if (mounted) busy = false; }
	}
</script>

{#snippet fieldError(field: string)}
	{#if invalidField === field}<Field.Error id={`${fieldId}-${field}-error`}>{invalidMessage}</Field.Error>{/if}
{/snippet}

<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<div class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></div>
<div class="space-y-4">
	<Field.Group layout="row">
		<OrderProductCombobox id={`${fieldId}-product`} {products} bind:value={selected} onselect={productId => { void choose(productId); }} disabled={busy || Boolean(command) || !loaded} />
		<AdminProductScanner products={loaded ? products : null} disabled={busy || Boolean(command) || failed} onproduct={productId => { void choose(productId); }} />
	</Field.Group>
	{#if loading && !loaded && !selected}<span class="sr-only" role="status">{m.load}</span>{/if}
	{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load} disabled={loading}>{m.retry}</Button>{/if}
	{#if loaded && !failed && !products.length}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>{/if}
</div>
{#if selected && !detail && loading && !failed}
	<span class="sr-only" role="status">{m.load}</span>
	<div class="mt-5 space-y-8" aria-hidden="true">
		<div class="space-y-2"><Skeleton class="h-5 w-32" /><Skeleton class="h-8 w-48" /></div>
		<div class="space-y-4"><Skeleton class="h-8 w-64" /><Skeleton class="h-12 w-full max-w-md" /><Skeleton class="h-12 w-40" /><Skeleton class="h-24 w-full" /></div>
		<div class="space-y-4"><Skeleton class="h-8 w-48" /><Skeleton class="h-16 w-full" /><Skeleton class="h-16 w-full" /></div>
	</div>
{/if}
{#if product && detail}
	<div class="mt-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 text-sm">
		<div>
			<p class="text-muted-foreground">{m.stock}</p>
			<p class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span class={['font-mono text-xl font-semibold', compareDecimals(detail.stock.quantity, '0') <= 0 && 'text-destructive']}>{formatDecimal(detail.stock.quantity, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, detail.stock.quantity)}</span>
				<StockBadge quantity={failed ? null : detail.stock.quantity} unit={unitLabel(product.unit_code, i18n.locale)} showQuantity={false} />
			</p>
		</div>
		<Button variant="link" size="sm" href={i18n.href(`/admin/products/${product.id}`)}>{i18n.m.adminProducts.editProduct}</Button>
	</div>
	<section class={section({ spacing: 'divided' })} aria-labelledby="stock-action-title">
		<Separator />
		<h2 id="stock-action-title" class={sectionHeading}>{m.actionHeading}</h2>
		<form class={formLayout} onsubmit={submit} oninput={() => { invalidField = ''; }}>
			<Field.Set class="gap-2">
				<Field.Legend id={`${fieldId}-kind`} variant="label">{m.kind}</Field.Legend>
				<ToggleGroup.Root type="single" variant="outline" spacing={2} class="flex-wrap" value={kind} disabled={Boolean(command) || busy} aria-labelledby={`${fieldId}-kind`}
					onValueChange={(value) => { if (value) { kind = value as typeof kind; movementId = ''; counted = ''; outcome = 'idle'; } }}>
					<ToggleGroup.Item value="withdraw">{m.withdraw}</ToggleGroup.Item>
					<ToggleGroup.Item value="adjust">{m.adjust}</ToggleGroup.Item>
					<ToggleGroup.Item value="correct">{m.correct}</ToggleGroup.Item>
				</ToggleGroup.Root>
			</Field.Set>
			<Field.Group layout="row">
				{#if kind === 'correct'}<Field.Field width="grow"><Field.Label for={`${fieldId}-movement`}>{m.movement}</Field.Label><NativeSelect.Root id={`${fieldId}-movement`} bind:value={movementId} disabled={Boolean(command) || busy}><NativeSelect.Option value="">{m.chooseMovement}</NativeSelect.Option>{#each detail.movements as movement (movement.id)}<NativeSelect.Option value={movement.id}>#{movement.id} · {m.kindLabels[movement.kind as keyof typeof m.kindLabels]} · {formatDecimal(movement.delta, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, movement.delta)}</NativeSelect.Option>{/each}</NativeSelect.Root></Field.Field>{/if}
			</Field.Group>
			{#if original}
				<p class="text-sm">#{original.id} · {m.kindLabels[original.kind as keyof typeof m.kindLabels]} · {formatDecimal(original.delta, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, original.delta)} · {formatCountedAt(original.at, i18n.locale)}</p>
				{#if original.orderId}<p class="text-sm"><a href={i18n.href(`/admin/orders/${original.orderId}`)}>{m.orderProgress(formatDecimal(original.received!, i18n.locale), formatDecimal(original.outstanding!, i18n.locale))}</a></p>{/if}
				{#if earlier.length}<div><h3 class="font-semibold">{m.priorCorrections}</h3>{#each earlier as entry (entry.id)}<p class="text-sm">#{entry.id}: {formatDecimal(entry.delta, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, entry.delta)} · {formatCountedAt(entry.at, i18n.locale)}</p>{/each}</div>{/if}
				{#if recount}<Alert.Message appearance="inline" variant="default" role="status">{m.recount}</Alert.Message>{/if}
			{/if}
			<Field.Group layout="row">
				<Field.Field width="medium"><Field.Label for={`${fieldId}-quantity`}>{kind === 'withdraw' ? m.quantity : m.delta} <span class="sr-only">({unitLabel(product.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-quantity`} aria-invalid={invalidField === 'quantity'} aria-describedby={invalidField === 'quantity' ? `${fieldId}-quantity-error` : undefined} type="text" required inputmode="decimal" autocomplete="off" bind:value={quantity} disabled={Boolean(command) || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(product.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError('quantity')}</Field.Field>
				{#if kind === 'correct' && recount}<Field.Field width="medium"><Field.Label for={`${fieldId}-counted`}>{m.counted} <span class="sr-only">({unitLabel(product.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${fieldId}-counted`} aria-invalid={invalidField === 'counted'} aria-describedby={invalidField === 'counted' ? `${fieldId}-counted-error` : undefined} type="text" required inputmode="decimal" autocomplete="off" bind:value={counted} disabled={Boolean(command) || busy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(product.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{@render fieldError('counted')}</Field.Field>{/if}
			</Field.Group>
			{#if kind === 'correct' && recount}<Field.Field orientation="horizontal"><Checkbox id={`${fieldId}-paused`} required bind:checked={paused} disabled={Boolean(command) || busy} /><Field.Label for={`${fieldId}-paused`} class="cursor-pointer">{m.pauseConfirmed}</Field.Label></Field.Field>{/if}
			<Field.Field width="grow"><Field.Label for={`${fieldId}-reason`}>{m.reason}</Field.Label><Textarea id={`${fieldId}-reason`} aria-invalid={invalidField === 'reason'} aria-describedby={`${fieldId}-reason-hint${invalidField === 'reason' ? ` ${fieldId}-reason-error` : ''}`} required maxlength={2000} bind:value={reason} disabled={Boolean(command) || busy} /><Field.Description id={`${fieldId}-reason-hint`}>{m.noteHint}</Field.Description>{@render fieldError('reason')}</Field.Field>
			<div class={formActions}><Button type="submit" disabled={busy || loading || admin.status !== 'ready' || !storageReady || failed || reviewNeeded || wrongIdentity || otherProduct || (!command && kind === 'correct' && (!original || (recount && !paused)))}><ButtonLabel pending={busy} pendingLabel={m.working} label={command ? m.retrySame : m.save} reserveLabels={[m.retrySame, m.save]} /></Button>
				{#if reviewNeeded}<Button type="button" variant="outline" disabled={loading || failed} onclick={() => { reviewNeeded = false; paused = false; outcome = 'idle'; }}>{m.reviewed}</Button>{/if}
			</div>
		</form>
		<div class={formStatus} aria-live="polite">
			{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storage}</Alert.Message>
			{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
			{:else if otherProduct}<Alert.Message appearance="inline" variant="default" role="status">{m.pendingElsewhere}</Alert.Message>
			{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknown}</Alert.Message>
			{:else if outcome === 'stale'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.stale}</Alert.Message>
			{:else if outcome === 'recount'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.recountRequired}</Alert.Message>
			{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalid}</Alert.Message>
			{:else if outcome === 'saved'}<Alert.Message appearance="inline" variant="default" role="status">{m.saved}</Alert.Message>{/if}
		</div>
		{#if command && otherProduct && storageReady && !wrongIdentity}<Button variant="link" onclick={() => { if (command && !busy) { selected = command.productId; void load(); } }}>{i18n.m.adminProducts.resume}</Button>{/if}
	</section>
	<!-- The history appears once something has been recorded. -->
	{#if detail.movements.length || detail.counts.length}
	<section class={section({ spacing: 'divided' })} aria-labelledby="stock-history-title">
		<Separator /><h2 id="stock-history-title" class={sectionHeading}>{m.history}</h2>
		<Item.Group>
			{#each [...detail.movements.map(entry => ({ at: entry.at, id: entry.id, movement: entry, count: null })), ...detail.counts.map(entry => ({ at: entry.at, id: entry.eventId, movement: null, count: entry }))].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)) as row, index (row.id)}
				{#if index > 0}<Item.Separator />{/if}
				<Item.Root variant="row" role="listitem">
					<Item.Content class="min-w-0 basis-72">
						{#if row.movement}
							<Item.Title class={itemTitle}>{m.kindLabels[row.movement.kind as keyof typeof m.kindLabels]} <span class="font-mono">{formatDecimal(row.movement.delta, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, row.movement.delta)}</span></Item.Title>
							<Item.Description>
								{formatCountedAt(row.at, i18n.locale)}{#if row.movement.actor} · {i18n.m.adminOrders.recordedBy(row.movement.actor)}{/if} · #{row.movement.id}{#if row.movement.corrects} · {m.corrects(row.movement.corrects)}{/if}{#if row.movement.orderId} · <a href={i18n.href(`/admin/orders/${row.movement.orderId}`)}>{i18n.m.adminOrders.detailHeading}</a>{/if}
							</Item.Description>
							{#if row.movement.note}<p class="text-sm">{row.movement.note}</p>{/if}
						{:else if row.count}
							{@const difference = countDifference(row.count.quantity, row.count.expected)}
							<Item.Title class={itemTitle}>{m.count}</Item.Title>
							<Item.Description>{formatCountedAt(row.at, i18n.locale)}{#if row.count.actor} · {i18n.m.adminOrders.recordedBy(row.count.actor)}{/if}</Item.Description>
							<dl class="grid gap-2 text-sm md:grid-cols-[repeat(3,minmax(0,14rem))] md:justify-start [&>div]:grid [&>div]:grid-cols-2 [&>div]:gap-4 md:[&>div]:block [&_dd]:m-0 [&_dd]:text-right md:[&_dd]:mt-1 md:[&_dd]:text-left md:[&_dt]:text-muted-foreground"><div><dt>{i18n.m.adminCounts.expected}</dt><dd class="font-mono">{formatDecimal(row.count.expected, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, row.count.expected)}</dd></div><div><dt>{i18n.m.adminCounts.observed}</dt><dd class="font-mono">{formatDecimal(row.count.quantity, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, row.count.quantity)}</dd></div><div><dt>{i18n.m.adminCounts.difference}</dt><dd class="font-mono" class:text-destructive={compareDecimals(difference, '0') !== 0}>{formatDecimal(difference, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, difference)}</dd></div></dl>
							{#if row.count.note}<p class="text-sm">{row.count.note}</p>{/if}
						{/if}
					</Item.Content>
					{#if row.movement && !command}<Item.Actions><Button type="button" variant="outline" size="sm" onclick={() => { kind = 'correct'; movementId = row.movement!.id; outcome = 'idle'; }}>{m.correct}</Button></Item.Actions>{/if}
				</Item.Root>
			{/each}
		</Item.Group>
	</section>
	{/if}
{/if}
