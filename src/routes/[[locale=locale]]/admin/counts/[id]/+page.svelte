<script lang="ts">
	import { productName } from '#lib/catalog.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { codeText, formLayout, formStatus, itemTitle, lede, nameWrap, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import StateBadge from '#lib/StateBadge.svelte';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import { onMount, tick, untrack } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import { page } from '$app/state';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { parseShelfTopology } from '#lib/shelf-map.js';
	import { api } from '#lib/convex.js';
	import { uuidPattern } from '#lib/api.js';
	import { compareDecimals } from '#lib/decimal.js';
	import { formatCountedAt, formatDecimal, gridCell, gridRange, unitLabel } from '#lib/format.js';
	import CountForm from '#lib/CountForm.svelte';
	import OrderProductCombobox from '#lib/OrderProductCombobox.svelte';
	import AdminProductScanner from '#lib/AdminProductScanner.svelte';
	import ShelfPlacementPicker from '#lib/ShelfPlacementPicker.svelte';
	import { clearCountCommand, countBatchAccess, countCommandPath, countDifference, countRejection, countStorageEvent, formatSignedDifference, readCountCommand, runCountCommand, saveCountCommand, updateCountStorage, type CountCommand } from '#lib/admin-counts.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminCounts);
	let drawerFilter = $state<string | null>(null);
	let busy = $state(false); let storageReady = $state(false); let selected = $state('');
	let command = $state<CountCommand | null>(null); let reason = $state(''); let finishOpen = $state(false); let finishTrigger = $state<HTMLButtonElement | null>(null); let outcome = $state<'idle' | 'unknown' | 'failed' | 'owner' | 'saved'>('idle');
	let mounted = false; let displayedId = '';
	// Live: observations, closure and ownership changes appear as they happen, in
	// every tab. Each count form keeps the revision its person counted against.
	const batchId = $derived(page.params.id ?? '');
	// A count pending in this browser needs its product even once the batch is read-only.
	const pendingProductId = $derived(command?.kind === 'count' && command.batchId === batchId ? command.productId : undefined);
	let resubscribing = $state(false);
	const live = useQuery(api.stock.countDetail, () => admin.status === 'ready' && uuidPattern.test(batchId) && !resubscribing
		? { batchId, ...(pendingProductId ? { productId: pendingProductId } : {}) } : 'skip', { keepPreviousData: true });
	// A failed update leaves data undefined; keep the last good read on screen beside the
	// error, so a count being typed survives until Retry.
	let lastRead = $state.raw<typeof live.data>(undefined);
	$effect(() => { if (live.data !== undefined) lastRead = live.data; });
	const read = $derived(live.error ? lastRead : live.data);
	// undefined while unknown, null when missing; never another batch's data while the next one loads.
	const current = $derived(!uuidPattern.test(batchId) ? null : read === null ? (live.isStale ? undefined : null)
		: read?.batch.id === batchId ? read : undefined);
	const failed = $derived(Boolean(live.error) && !resubscribing);
	const loading = $derived(current === undefined && !failed);
	const batch = $derived(current?.batch ?? null); const owners = $derived(current?.owners ?? []);
	const products = $derived(current?.products ?? []); const observations = $derived(current?.observations ?? []);
	$effect(() => { if (live.error) void admin.permissionFailure(live.error); });
	// A failed read is retried with a fresh subscription.
	async function resubscribe() { resubscribing = true; await tick(); resubscribing = false; }
	// The drawer filter is optional: an unreadable shelf map only hides it.
	const shelf = useQuery(api.catalog.shelfMap, {});
	const topology = $derived.by(() => { try { return shelf.data ? parseShelfTopology(shelf.data) : null; } catch { return null; } });
	$effect(() => { if (drawerFilter && topology && !topology.bins.some((bin) => bin.id === drawerFilter)) drawerFilter = null; });
	const ownerById = $derived(new Map(owners.map(owner => [owner.id, owner])));
	const productById = $derived(new Map(products.map(product => [product.id, product])));
	const owner = $derived(batch ? ownerById.get(batch.ownerId) : undefined);
	const access = $derived(batch && admin.membership ? countBatchAccess(batch, owner, admin.membership.id) : null);
	const ownerName = (id: string | null) => (id && ownerById.get(id)?.name) || m.unknownAdmin;
	const batchName = $derived(batch && batch.id === page.params.id ? (batch.productId ? m.singleCount(batch.title) : batch.title) : m.detailHeading);
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.userId));
	const pendingHere = $derived(Boolean(command && command.kind !== 'start' && command.batchId === page.params.id));
	const pendingCount = $derived(pendingHere && command?.kind === 'count');
	const selectedProduct = $derived(productById.get(selected));
	// Products already counted in this stock count, so a drawer shows what is left.
	const counted = $derived(new Set(observations.map((observation) => observation.productId)));
	const matches = $derived(drawerFilter === null ? products : products.filter((product) => product.bin_id === drawerFilter));
	const batchTone = { owner: 'success', other: 'neutral', abandoned: 'warning', finished: 'neutral' } as const;
	// A scanned label picks its product directly; a drawer filter that excludes it is lifted.
	function scanned(productId: string) {
		if (drawerFilter !== null && productById.get(productId)?.bin_id !== drawerFilter) drawerFilter = null;
		selected = productId;
	}
	function drawerName(id: string): string {
		const bin = topology?.bins.find((value) => value.id === id);
		const cabinet = topology?.cabinets.find((value) => value.id === bin?.cabinet_id);
		return bin && cabinet ? i18n.m.adminProducts.location(gridCell(cabinet.outer_row, cabinet.outer_col), gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span)) : '';
	}
	function syncPending() {
		if (busy) return;
		try {
			command = readCountCommand(localStorage);
			if (command && command.kind !== 'start' && command.batchId === page.params.id) {
				if (command.kind === 'count') selected = command.productId;
				else { reason = command.kind === 'close' ? command.reason : ''; outcome = 'unknown'; }
			}
		} catch { storageReady = false; }
	}
	onMount(() => {
		mounted = true;
		syncPending();
		void updateCountStorage((storage) => { readCountCommand(storage); const key = 'ampoteket:count-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); }).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(countStorageEvent, syncPending);
		return () => { mounted = false; window.removeEventListener('storage', syncPending); window.removeEventListener(countStorageEvent, syncPending); };
	});
	$effect(() => {
		const id = page.params.id;
		if (id) untrack(() => {
			if (displayedId !== id) {
				displayedId = id;
				selected = ''; drawerFilter = null; finishOpen = false; reason = ''; outcome = 'idle';
				if (mounted) syncPending();
			}
		});
	});
	// Finishing is final: confirm first. A pending command was already confirmed, so its retry goes straight through.
	function requestFinish(event: SubmitEvent) {
		event.preventDefault();
		if (command) void finish(); else finishOpen = true;
	}
	async function finish() {
		finishOpen = false;
		if (admin.status !== 'ready' || busy || loading || failed || !batch || batch.id !== page.params.id || !storageReady || wrongIdentity || (command && (!pendingHere || command.kind === 'count'))) return;
		if (!command && access !== 'owner' && access !== 'abandoned') return;
		if (!command && access === 'abandoned' && !reason.trim()) return;
		busy = true; outcome = 'idle';
		let frozen: CountCommand | null = null;
		try {
			const session = admin.credentials();
			const candidate: CountCommand = command ?? (access === 'owner'
			? { kind: 'finish', userId: session.userId, requestId: crypto.randomUUID(), batchId: batch.id }
			: { kind: 'close', userId: session.userId, requestId: crypto.randomUUID(), batchId: batch.id, reason: reason.trim() });
			frozen = await updateCountStorage((storage) => saveCountCommand(storage, candidate)); command = frozen;
			await runCountCommand(session, frozen); await updateCountStorage((storage) => clearCountCommand(storage, frozen!));
			if (mounted && admin.userId === session.userId) { command = null; outcome = 'saved'; }
		} catch (error) {
			if (frozen && countRejection(error)) {
				try { await updateCountStorage((storage) => clearCountCommand(storage, frozen!)); if (mounted) { command = null; outcome = 'owner'; } }
				catch { if (mounted) outcome = 'unknown'; }
			} else if (mounted) outcome = frozen ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally { if (mounted) busy = false; }
	}
</script>

<svelte:head><title>{m.detailTitle(batchName)}</title></svelte:head>
<header class={pageHeader}>
	<h1 class={pageHeading}>{batchName}</h1>
	{#if batch && batch.id === page.params.id && access}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
			<StateBadge tone={batchTone[access]}>{m.batchStates[access]}</StateBadge>
			<span>{m.owner}: <strong class="font-medium text-foreground">{ownerName(batch.ownerId)}</strong>{access === 'owner' ? ` ${m.you}` : ''} · {m.started(formatCountedAt(batch.startedAt, i18n.locale))}</span>
			{#if batch.finishedAt}<span>{m.finished(formatCountedAt(batch.finishedAt, i18n.locale), ownerName(batch.finishedBy))}</span>{/if}
		</div>
		{#if batch.finishReason}<p class="text-sm text-muted-foreground">{m.closureReason}: {batch.finishReason}</p>{/if}
	{/if}
</header>
<div class={formStatus} aria-live="polite">
	{#if failed}<Alert.Message appearance="inline" variant="destructive">{m.detailLoadFailed}</Alert.Message>{:else if !batch && !loading}<Alert.Message appearance="inline" variant="default">{m.missing}</Alert.Message>{/if}{#if !storageReady}<Alert.Message appearance="inline" variant="destructive">{m.storageUnavailable}</Alert.Message>{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive">{m.wrongIdentity}</Alert.Message>{:else if command && !pendingHere}<Alert.Message appearance="inline" variant="default">{m.pendingElsewhere}</Alert.Message>{/if}
</div>
{#if failed}<Button variant="outline" type="button" disabled={resubscribing || busy} onclick={resubscribe}>{m.retryLoad}</Button>{/if}
{#if storageReady && !wrongIdentity && command && !pendingHere}<Button variant="link" href={i18n.href(countCommandPath(command))}>{m.resumePending}</Button>{/if}
{#if !batch && loading}
	<span class="sr-only" role="status">{m.loading}</span>
	<div class="min-h-128 space-y-6" aria-busy="true" aria-hidden="true"><Skeleton class="h-8 w-2/3" /><Skeleton class="h-6 w-1/2" /><Skeleton class="h-80 w-full" /></div>
{/if}
{#if batch && batch.id === page.params.id && access}
	{#if access === 'other'}<Alert.Message appearance="inline">{m.ownerOnly}</Alert.Message>{/if}
	{#if access === 'owner' || pendingCount}
		<section class={section()} aria-labelledby="choose-product-title">
			<h2 class={sectionHeading} id="choose-product-title">{m.chooseProduct}</h2>
			<p class={lede}>{m.matchingCounts}</p>
			<div class={formLayout}>
				{#if topology?.cabinets.length}
					<Field.Set class="gap-3">
						<Field.Legend>{m.drawerFilter}</Field.Legend>
						<p class="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1" aria-live="polite">{#if drawerFilter}<strong>{drawerName(drawerFilter)}</strong><Button variant="ghost" type="button" disabled={loading || Boolean(command)} onclick={() => { drawerFilter = null; }}>{m.allProducts}</Button>{/if}</p>
						<ShelfPlacementPicker {topology} selected={drawerFilter} disabled={loading || Boolean(command)} onselect={(id) => { drawerFilter = id; }} />
					</Field.Set>
				{/if}
				{#if drawerFilter !== null && matches.length}
					<Field.Set class="gap-3">
						<Field.Legend id={`${fieldId}-drawer-products`} variant="label">{m.drawerProducts}</Field.Legend>
						<RadioGroup.Root value={selected} onValueChange={(value) => { selected = value; }} aria-labelledby={`${fieldId}-drawer-products`} disabled={loading || Boolean(command)}>
							{#each matches as product (product.id)}
								<Field.Field orientation="horizontal" class="min-w-0 *:data-[slot=field-label]:flex-initial">
									<RadioGroup.Item id={`${fieldId}-drawer-${product.id}`} value={product.id} />
									<Field.Label for={`${fieldId}-drawer-${product.id}`} class={['font-normal', nameWrap]}><span><span class={codeText}>{product.code}</span>: {productName(product, i18n.locale)}</span></Field.Label>
									{#if !product.is_active}<StateBadge class="shrink-0">{i18n.m.adminProducts.inactive}</StateBadge>{/if}
									{#if counted.has(product.id)}<StateBadge tone="success" class="shrink-0">{m.countedHere}</StateBadge>{/if}
								</Field.Field>
							{/each}
						</RadioGroup.Root>
					</Field.Set>
				{/if}
				<Field.Group layout="row">
					<OrderProductCombobox id={`${fieldId}-2`} products={matches} bind:value={selected} disabled={loading || Boolean(command)} />
					<AdminProductScanner products={products.length ? products : null} disabled={loading || Boolean(command)} onproduct={scanned} />
				</Field.Group>
				{#if !matches.length}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>{/if}
			</div>
			{#if selectedProduct}{#key `${batch.id}:${selectedProduct.id}`}<CountForm product={selectedProduct} batchId={batch.id} submissionBlocked={loading || failed} />{/key}{/if}
		</section>
	{/if}
	{#if access === 'owner' || access === 'abandoned' || (pendingHere && !pendingCount)}
		{@const closing = access === 'abandoned' || command?.kind === 'close'}
		<section class={section({ spacing: 'divided', class: "finish-section" })} aria-labelledby="finish-count-title">
			<Separator />
			<h2 class={sectionHeading} id="finish-count-title">{closing ? m.closeAbandoned : m.finish}</h2>
			<p>{closing ? m.abandonedExplanation : m.finishExplanation}</p>
			<form class={formLayout} onsubmit={requestFinish}>
				{#if closing}<Field.Field width="grow"><Field.Label for={`${fieldId}-3`}>{m.closureReason}</Field.Label><Textarea id={`${fieldId}-3`} rows={3} maxlength={2000} required bind:value={reason} disabled={busy || Boolean(command)} aria-describedby={`${fieldId}-3-hint`}></Textarea><Field.Description id={`${fieldId}-3-hint`}>{m.closureReasonHint}</Field.Description></Field.Field>{/if}
				<Button bind:ref={finishTrigger} type="submit" disabled={loading || failed || busy || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind === 'count'))}><ButtonLabel pending={busy} pendingLabel={m.finishing} label={pendingHere && !pendingCount ? m.retryFinish : closing ? m.closeAbandoned : m.finish} reserveLabels={[m.retryFinish, closing ? m.closeAbandoned : m.finish]} /></Button>
			</form>
			<div class={formStatus} aria-live="polite">{#if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive">{m.unknownFinish}</Alert.Message>{:else if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive">{m.finishFailed}</Alert.Message>{:else if outcome === 'owner'}<Alert.Message appearance="inline" variant="destructive">{m.ownerChanged}</Alert.Message>{/if}</div>
			<AlertDialog.Root bind:open={finishOpen}>
				<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); finishTrigger?.focus({ preventScroll: true }); }}>
					<AlertDialog.Header>
						<AlertDialog.Title>{closing ? m.closeAbandoned : m.finish}</AlertDialog.Title>
						<AlertDialog.Description>{closing ? m.closeDialog : m.finishDialog}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{i18n.m.admin.cancel}</AlertDialog.Cancel>
						<AlertDialog.Action variant="destructive" disabled={admin.status !== 'ready' || loading || failed || busy} onclick={() => { void finish(); }}>{closing ? m.closeAbandoned : m.finish}</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</section>
	{/if}
	<section class={section({ spacing: 'divided', class: "history-section" })} aria-labelledby="count-history-title">
		<Separator />
		<h2 class={sectionHeading} id="count-history-title">{m.history}</h2>
		{#if !observations.length}<Empty.Root><Empty.Description>{m.noObservations}</Empty.Description></Empty.Root>{/if}
		<Item.Group class="observations">{#each observations as observation, index (observation.eventId)}
			{#if index > 0}<Item.Separator />{/if}
			{@const product = productById.get(observation.productId)}
			{@const unit = product?.unit_code ?? ''}
			{@const difference = countDifference(observation.counted, observation.expected)}
			{@const changed = compareDecimals(difference, '0') !== 0}
			<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0"><Item.Title><h3 class={[itemTitle, nameWrap]}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/products/${observation.productId}`)}>{#if product}<span class={codeText}>{product.code}</span>: {productName(product, i18n.locale)}{:else}{m.unknownProduct}{/if}</a></h3>{#if product && !product.is_active}<StateBadge>{i18n.m.adminProducts.inactive}</StateBadge>{/if}</Item.Title>
				<Item.Description>{formatCountedAt(observation.recordedAt, i18n.locale)} · {ownerName(observation.actorId)}</Item.Description>
				<dl class="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-3 [&_dd]:m-0 [&_dd]:font-mono [&_dt]:text-sm [&_dt]:text-muted-foreground"><div><dt>{m.expected}</dt><dd>{formatDecimal(observation.expected, i18n.locale)} {unitLabel(unit, i18n.locale, observation.expected)}</dd></div><div><dt>{m.observed}</dt><dd>{formatDecimal(observation.counted, i18n.locale)} {unitLabel(unit, i18n.locale, observation.counted)}</dd></div><div><dt>{m.difference}</dt><dd class:text-destructive={changed} class:font-semibold={changed}>{formatSignedDifference(difference, i18n.locale)} {unitLabel(unit, i18n.locale, difference)}</dd></div></dl>
				{#if observation.note}<p class="text-sm">{observation.note}</p>{/if}
			</Item.Content></Item.Root>
		{/each}</Item.Group>
	</section>
{/if}
