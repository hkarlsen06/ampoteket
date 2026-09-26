<script lang="ts">
	import { productName } from '$lib/catalog';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { codeText, formLayout, formStatus, itemTitle, lede, nameWrap, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import StateBadge from '$lib/StateBadge.svelte';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Field from '$lib/components/ui/field';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { readShelfTopology, type ShelfTopology } from '$lib/shelf-map';
	import { uuidPattern } from '$lib/api';
	import { compareDecimals } from '$lib/decimal';
	import { formatCountedAt, formatDecimal, gridCell, gridRange, unitLabel } from '$lib/format';
	import CountForm from '$lib/CountForm.svelte';
	import OrderProductCombobox from '$lib/OrderProductCombobox.svelte';
	import AdminProductScanner from '$lib/AdminProductScanner.svelte';
	import ShelfPlacementPicker from '$lib/ShelfPlacementPicker.svelte';
	import { clearCountCommand, countBatchAccess, countCommandPath, countDifference, countRejection, countStorageEvent, readCountDetail, readCountCommand, runCountCommand, saveCountCommand, updateCountStorage, type CountBatch, type CountCommand, type CountObservation, type CountOwner, type CountProductChoice } from '$lib/admin-counts';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminCounts);
	let batch = $state<CountBatch | null>(null); let owners = $state<CountOwner[]>([]); let products = $state<CountProductChoice[]>([]); let observations = $state<CountObservation[]>([]);
	let topology = $state<ShelfTopology | null>(null); let drawerFilter = $state<string | null>(null);
	let loading = $state(true); let failed = $state(false); let busy = $state(false); let storageReady = $state(false); let selected = $state('');
	let command = $state<CountCommand | null>(null); let reason = $state(''); let finishOpen = $state(false); let finishTrigger = $state<HTMLButtonElement | null>(null); let outcome = $state<'idle' | 'unknown' | 'failed' | 'owner' | 'saved'>('idle');
	let mounted = false; let generation = 0; let displayedId = '';
	const ownerById = $derived(new Map(owners.map(owner => [owner.id, owner])));
	const productById = $derived(new Map(products.map(product => [product.id, product])));
	const owner = $derived(batch ? ownerById.get(batch.ownerId) : undefined);
	const access = $derived(batch && owner && admin.membership ? countBatchAccess(batch, owner, admin.membership.id) : null);
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const pendingHere = $derived(Boolean(command && command.kind !== 'start' && command.batchId === page.params.id));
	const pendingCount = $derived(pendingHere && command?.kind === 'count');
	const selectedProduct = $derived(productById.get(selected));
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
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(countStorageEvent, syncPending); };
	});
	$effect(() => {
		const id = page.params.id;
		if (id) untrack(() => {
			if (displayedId !== id) {
				displayedId = id; batch = null; owners = []; products = []; observations = [];
				selected = ''; drawerFilter = null; finishOpen = false; reason = ''; outcome = 'idle';
				if (mounted) syncPending();
			}
			void load(id);
		});
	});
	async function load(id = page.params.id!) {
		if (admin.status !== 'ready') return;
		const version = ++generation; loading = true; failed = false;
		if (!uuidPattern.test(id)) { batch = null; loading = false; return; }
		try {
			const session = admin.credentials();
			const [detail, shelf] = await Promise.all([readCountDetail(session, id, admin.membership!.id, {
				productId: pendingCount && command?.kind === 'count' ? command.productId : undefined
			}), readShelfTopology(session.config)]);
			if (!mounted || version !== generation || admin.session?.user.id !== session.userId) return;
			batch = detail.batch; owners = detail.owners; products = detail.products; observations = detail.observations; topology = shelf;
			if (drawerFilter && !shelf.bins.some((bin) => bin.id === drawerFilter)) drawerFilter = null;
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read on return to the
	// tab instead of offering a manual refresh button.
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(loading || busy)) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
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
			if (mounted && admin.session?.user.id === session.userId) { command = null; outcome = 'saved'; await load(); }
		} catch (error) {
			if (frozen && countRejection(error)) {
				try { await updateCountStorage((storage) => clearCountCommand(storage, frozen!)); if (mounted) { command = null; outcome = 'owner'; await load(); } }
				catch { if (mounted) outcome = 'unknown'; }
			} else if (mounted) outcome = frozen ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally { if (mounted) busy = false; }
	}
</script>

<svelte:head><title>{m.detailTitle}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{batch && batch.id === page.params.id ? batch.title : m.detailHeading}</h1>
	{#if batch && batch.id === page.params.id && owner && access}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
			<StateBadge tone={batchTone[access]}>{m.batchStates[access]}</StateBadge>
			<span>{m.owner}: <strong class="font-medium text-foreground">{owner.name}</strong> · {m.started(formatCountedAt(batch.startedAt, i18n.locale))}</span>
			{#if batch.finishedAt}<span>{m.finished(formatCountedAt(batch.finishedAt, i18n.locale), ownerById.get(batch.finishedBy!)?.name ?? '')}</span>{/if}
		</div>
		{#if batch.finishReason}<p class="text-sm text-muted-foreground">{m.closureReason}: {batch.finishReason}</p>{/if}
	{/if}
</header>
<div class={formStatus} aria-live="polite">
	{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{:else if !batch && !loading}<Alert.Message appearance="inline" variant="default" role="status">{m.missing}</Alert.Message>{/if}{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>{:else if command && !pendingHere}<Alert.Message appearance="inline" variant="default" role="status">{m.pendingElsewhere}</Alert.Message>{/if}
</div>
{#if failed}<Button variant="outline" type="button" disabled={loading || busy} onclick={() => load()}>{m.retryLoad}</Button>{/if}
{#if storageReady && !wrongIdentity && command && !pendingHere}<Button variant="link" href={i18n.href(countCommandPath(command))}>{m.resumePending}</Button>{/if}
{#if !batch && loading}
	<span class="sr-only" role="status">{m.loading}</span>
	<div class="min-h-128 space-y-6" aria-busy="true" aria-hidden="true"><Skeleton class="h-8 w-2/3" /><Skeleton class="h-6 w-1/2" /><Skeleton class="h-80 w-full" /></div>
{/if}
{#if batch && batch.id === page.params.id && owner && access}
	{#if access === 'other'}<Alert.Message appearance="inline" role="status">{m.ownerOnly}</Alert.Message>{/if}
	{#if access === 'owner' || pendingCount}
		<section class={section()} aria-labelledby="choose-product-title">
			<h2 class={sectionHeading} id="choose-product-title">{m.chooseProduct}</h2>
			<p class={lede}>{m.immediate}</p>
			<div class={formLayout}>
				{#if topology?.cabinets.length}
					<Field.Set class="gap-3">
						<Field.Legend>{m.drawerFilter}</Field.Legend>
						<p class="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1" aria-live="polite">{#if drawerFilter}<strong>{drawerName(drawerFilter)}</strong><Button variant="ghost" type="button" disabled={loading || Boolean(command)} onclick={() => { drawerFilter = null; }}>{m.allProducts}</Button>{/if}</p>
						<ShelfPlacementPicker {topology} selected={drawerFilter} disabled={loading || Boolean(command)} onselect={(id) => { drawerFilter = id; }} />
					</Field.Set>
				{/if}
				<Field.Group layout="row">
					<OrderProductCombobox id={`${fieldId}-2`} products={matches} bind:value={selected} disabled={loading || Boolean(command)} />
					<AdminProductScanner products={products.length ? products : null} disabled={loading || Boolean(command)} onproduct={scanned} />
				</Field.Group>
				{#if !matches.length}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>{/if}
			</div>
			{#if selectedProduct}{#key `${batch.id}:${selectedProduct.id}`}<CountForm product={selectedProduct} batchId={batch.id} submissionBlocked={loading || failed} onsaved={() => { void load(); }} />{/key}{/if}
		</section>
	{/if}
	{#if access === 'owner' || access === 'abandoned' || (pendingHere && !pendingCount)}
		{@const closing = access === 'abandoned' || command?.kind === 'close'}
		<section class={section({ spacing: 'divided', class: "finish-section" })} aria-labelledby="finish-count-title">
			<Separator />
			<h2 class={sectionHeading} id="finish-count-title">{closing ? m.closeAbandoned : m.finish}</h2>
			<p>{closing ? m.abandonedExplanation : m.finishExplanation}</p>
			<form class={formLayout} onsubmit={requestFinish}>
				{#if closing}<Field.Field width="grow"><Field.Label for={`${fieldId}-3`}>{m.closureReason}</Field.Label><Textarea id={`${fieldId}-3`} rows={3} maxlength={2000} required bind:value={reason} disabled={busy || Boolean(command)} aria-describedby={`${fieldId}-3-hint`}></Textarea><Field.Description id={`${fieldId}-3-hint`}>{m.noteHint}</Field.Description></Field.Field>{/if}
				<Button bind:ref={finishTrigger} type="submit" disabled={loading || failed || busy || !storageReady || wrongIdentity || Boolean(command && (!pendingHere || command.kind === 'count'))}><ButtonLabel pending={busy} pendingLabel={m.working} label={pendingHere && !pendingCount ? m.retryFinish : closing ? m.closeAbandoned : m.finish} reserveLabels={[m.retryFinish, closing ? m.closeAbandoned : m.finish]} /></Button>
			</form>
			<div class={formStatus} aria-live="polite">{#if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknownFinish}</Alert.Message>{:else if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{:else if outcome === 'owner'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.ownerChanged}</Alert.Message>{/if}</div>
			<AlertDialog.Root bind:open={finishOpen}>
				<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); finishTrigger?.focus({ preventScroll: true }); }}>
					<AlertDialog.Header>
						<AlertDialog.Title>{closing ? m.closeAbandoned : m.finish}</AlertDialog.Title>
						<AlertDialog.Description aria-label={closing ? m.closeAbandoned : m.finish}>{m.finishConfirmed}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{i18n.m.admin.cancel}</AlertDialog.Cancel>
						<AlertDialog.Action disabled={admin.status !== 'ready' || loading || failed || busy} onclick={() => { void finish(); }}>{closing ? m.closeAbandoned : m.finish}</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</section>
	{/if}
	{#if observations.length}
	<section class={section({ spacing: 'divided', class: "history-section" })} aria-labelledby="count-history-title">
		<Separator />
		<h2 class={sectionHeading} id="count-history-title">{m.history}</h2>
		<Item.Group class="observations">{#each observations as observation, index (observation.eventId)}
			{#if index > 0}<Item.Separator />{/if}
			{@const product = productById.get(observation.productId)!}
			{@const difference = countDifference(observation.counted, observation.expected)}
			<Item.Root variant="row" role="listitem"><Item.Content class="min-w-0"><Item.Title><h3 class={[itemTitle, nameWrap]}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/products/${product.id}`)}><span class={codeText}>{product.code}</span>: {productName(product, i18n.locale)}</a></h3>{#if !product.is_active}<StateBadge>{i18n.m.adminProducts.inactive}</StateBadge>{/if}</Item.Title>
				<Item.Description>{formatCountedAt(observation.recordedAt, i18n.locale)} · {ownerById.get(observation.actorId)!.name}</Item.Description>
				<dl class="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-3 [&_dd]:m-0 [&_dd]:font-mono [&_dt]:text-sm [&_dt]:text-muted-foreground"><div><dt>{m.expected}</dt><dd>{formatDecimal(observation.expected, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, observation.expected)}</dd></div><div><dt>{m.observed}</dt><dd>{formatDecimal(observation.counted, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, observation.counted)}</dd></div><div><dt>{m.difference}</dt><dd class:text-destructive={compareDecimals(difference, '0') !== 0}>{formatDecimal(difference, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, difference)}</dd></div></dl>
				{#if observation.note}<p class="text-sm">{observation.note}</p>{/if}
			</Item.Content></Item.Root>
		{/each}</Item.Group>
	</section>
	{/if}
{/if}
