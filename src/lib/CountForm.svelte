<script lang="ts">
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { unitLabel } from '#lib/format.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formLayout, formStatus, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import StockBadge from '#lib/StockBadge.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { onMount } from 'svelte';
	import { getI18n } from './i18n';
	import { getAdminContext } from './admin-context.svelte';
	import { compareDecimals } from './decimal';
	import { formatCountedAt, formatDecimal } from './format';
	import { clearCountCommand, countCommandPath, countDifference, countRejection, countStorageEvent, readCountCommand, readCountInventory, runCountCommand, saveCountCommand, updateCountStorage, validCountQuantity, type CountCommand, type CountProduct, type CountResult, type InventorySnapshot } from './admin-counts';
	let { product, batchId = undefined, onsaved = undefined, submissionBlocked = false, modal = false }: { product: CountProduct; batchId?: string; onsaved?: () => void; submissionBlocked?: boolean; modal?: boolean } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminCounts);
	const id = $props.id();
	let expanded = $state(false); let busy = $state(false); let storageReady = $state(false);
	let snapshot = $state<InventorySnapshot | null>(null); let quantity = $state(''); let note = $state(''); let paused = $state(false);
	let command = $state<CountCommand | null>(null); let result = $state<CountResult | null>(null);
	let status = $state<'idle' | 'loading' | 'failed' | 'invalid' | 'unknown' | 'stale' | 'closed' | 'owner'>('idle');
	let mounted = false; let generation = 0; let quantityField = $state<HTMLInputElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let rejectedObservation = $state<string | null>(null);
	const ownCommand = $derived(command?.kind === 'count' && command.productId === product.id && command.batchId === (batchId ?? null));
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const pendingElsewhere = $derived(Boolean(command && !ownCommand));
	const difference = $derived.by(() => {
		try { return snapshot ? countDifference(validCountQuantity(quantity, product.stock_step, i18n.locale), snapshot.quantity) : null; }
		catch { return null; }
	});
	onMount(() => {
		mounted = true;
		function syncPending() {
			try {
				command = readCountCommand(localStorage);
				if (command) expanded = true;
				if (!busy && command?.kind === 'count' && command.productId === product.id && command.batchId === (batchId ?? null)) {
					expanded = true; quantity = command.quantity; note = command.note ?? ''; paused = true;
					snapshot = { productId: command.productId, quantity: command.expected, revision: command.revision, lastCountedAt: null };
					status = 'unknown';
				}
			} catch { storageReady = false; }
		}
		syncPending();
		void updateCountStorage((storage) => { readCountCommand(storage); const key = 'ampoteket:count-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); })
			.then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(countStorageEvent, syncPending);
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(countStorageEvent, syncPending); };
	});
	async function observe() {
		if (busy || command || admin.status !== 'ready') return;
		expanded = true; busy = true; status = 'loading'; snapshot = null; result = null; rejectedObservation = null; quantity = ''; note = ''; paused = false;
		const version = ++generation;
		try {
			const session = admin.credentials();
			const loaded = await readCountInventory(session, product.id);
			if (mounted && version === generation && admin.session?.user.id === session.userId) { snapshot = loaded; status = 'idle'; }
		} catch (error) { if (mounted && version === generation) status = 'failed'; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) busy = false; }
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || submissionBlocked || admin.status !== 'ready' || !storageReady || wrongIdentity || pendingElsewhere || !snapshot || !paused) return;
		let observed: string;
		try { observed = validCountQuantity(quantity, product.stock_step, i18n.locale); }
		catch { status = 'invalid'; quantityField?.focus(); return; }
		busy = true; result = null; status = 'idle';
		let frozen: CountCommand | null = null;
		try {
			const session = admin.credentials();
			const candidate: CountCommand = command ?? { kind: 'count', userId: session.userId, requestId: crypto.randomUUID(), productId: product.id, batchId: batchId ?? null, revision: snapshot.revision, expected: snapshot.quantity, quantity: observed, note: note.trim() || null };
			frozen = await updateCountStorage((storage) => saveCountCommand(storage, candidate));
			command = frozen;
			const saved = await runCountCommand(session, frozen);
			await updateCountStorage((storage) => clearCountCommand(storage, frozen!));
			if (mounted && admin.session?.user.id === session.userId) { command = null; result = saved; snapshot = null; paused = false; status = 'idle'; onsaved?.(); }
		} catch (error) {
			const rejected = countRejection(error);
			if (frozen && rejected) {
				try { await updateCountStorage((storage) => clearCountCommand(storage, frozen!)); if (mounted) { if (frozen.kind === 'count') rejectedObservation = frozen.quantity; command = null; status = rejected; snapshot = null; quantity = ''; paused = false; } }
				catch { if (mounted) status = 'unknown'; }
			} else if (mounted) status = frozen ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally { if (mounted) busy = false; }
	}
</script>

{#snippet countBody()}
		{#if !batchId}<p>{m.immediate}</p>{/if}
		<ol class="list-decimal space-y-2 pl-6">{#each m.steps as step (step)}<li>{step}</li>{/each}</ol>
		<div class={formStatus} aria-live="polite">
			{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
			{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
			{:else if pendingElsewhere && command}<Alert.Message appearance="inline" variant="default" role="status">{m.pendingElsewhere}</Alert.Message>
			{:else if status === 'loading'}<span class="sr-only" role="status">{m.loadingStock}</span>
			{:else if status === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>
			{:else if status === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknown}</Alert.Message>
			{:else if status === 'stale'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.stale}</Alert.Message>{#if rejectedObservation}<Alert.Message appearance="inline" variant="default" role="status">{m.rejectedObservation(formatDecimal(rejectedObservation, i18n.locale), unitLabel(product.unit_code, i18n.locale, rejectedObservation))}</Alert.Message>{/if}
			{:else if status === 'closed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.closedDuringCount}</Alert.Message>
			{:else if status === 'owner'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.ownerOnly}</Alert.Message>
			{:else if result}<Alert.Message appearance="inline" variant="default" role="status">{m.saved(`${formatDecimal(result.quantity!, i18n.locale)} ${unitLabel(product.unit_code, i18n.locale, result.quantity!)}`, `${formatDecimal(result.difference!, i18n.locale)} ${unitLabel(product.unit_code, i18n.locale, result.difference!)}`)}</Alert.Message>{/if}
		</div>
		{#if storageReady && !wrongIdentity && pendingElsewhere && command}<Button variant="link" href={i18n.href(countCommandPath(command))}>{m.resumePending}</Button>{/if}
		{#if status === 'loading'}
			<div class="min-h-128 space-y-5" aria-busy="true" aria-hidden="true"><Skeleton class="h-6 w-48" /><Skeleton class="h-20 w-48" /><Skeleton class="h-28 w-full" /><Skeleton class="h-12 w-full" /><Skeleton class="h-12 w-48" /></div>
		{/if}
		{#if snapshot}
			<div class="mb-4 text-sm">
				<p class="text-muted-foreground">{m.recorded}</p>
				<p class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class={['font-mono text-xl font-semibold', compareDecimals(snapshot.quantity, '0') <= 0 && 'text-destructive']}>{formatDecimal(snapshot.quantity, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, snapshot.quantity)}</span><StockBadge quantity={snapshot.quantity} unit={unitLabel(product.unit_code, i18n.locale)} showQuantity={false} /></p>
				{#if snapshot.lastCountedAt}<p class="text-muted-foreground">{m.lastCount(formatCountedAt(snapshot.lastCountedAt, i18n.locale))}</p>{/if}
			</div>
			<form id={`${id}-form`} class={formLayout} onsubmit={submit}>
				<Field.Group layout="row">
					<Field.Field width="medium"><Field.Label for={`${id}-1`}>{m.observed} <span class="sr-only">({unitLabel(product.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id={`${id}-1`} bind:ref={quantityField} inputmode="decimal" autocomplete="off" enterkeyhint="next" required bind:value={quantity} disabled={busy || Boolean(command)} aria-invalid={status === 'invalid'} aria-describedby={`${id}-quantity-hint${status === 'invalid' ? ` ${id}-quantity-error` : ''}`} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(product.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root></Field.Field>
					<Field.Field width="medium"><Field.Label for={`${id}-difference`}>{m.difference}</Field.Label><output id={`${id}-difference`} class="difference flex min-h-12 items-center font-mono wrap-anywhere" class:text-destructive={difference !== null && compareDecimals(difference, '0') !== 0} class:font-semibold={difference !== null && compareDecimals(difference, '0') !== 0}>{difference === null ? m.enterQuantity : `${formatDecimal(difference, i18n.locale)} ${unitLabel(product.unit_code, i18n.locale, difference)}`}</output></Field.Field>
				</Field.Group>
				<Field.Description id={`${id}-quantity-hint`}>{m.quantityHint(formatDecimal(product.stock_step, i18n.locale), unitLabel(product.unit_code, i18n.locale, product.stock_step))}</Field.Description>
				{#if status === 'invalid'}<Field.Error id={`${id}-quantity-error`}>{m.invalidQuantity(formatDecimal(product.stock_step, i18n.locale))}</Field.Error>{/if}
				<Field.Field width="grow"><Field.Label for={`${id}-2`}>{m.note}</Field.Label><Textarea id={`${id}-2`} rows={3} maxlength={2000} bind:value={note} disabled={busy || Boolean(command)} aria-describedby={`${id}-note-hint`}></Textarea></Field.Field>
				<Field.Description id={`${id}-note-hint`}>{difference !== null && compareDecimals(difference, '0') !== 0 ? m.differenceNote : m.noteHint}</Field.Description>
				<Field.Field orientation="horizontal"><Checkbox id={`${id}-paused`} name={`${id}-paused`} required bind:checked={paused} disabled={busy || Boolean(command)} /><Field.Label for={`${id}-paused`} class="cursor-pointer">{m.pauseConfirmed}</Field.Label></Field.Field>
				{#if !modal}{@render countActions()}{/if}
			</form>
		{:else if !modal}
			{@render countActions()}
		{/if}
{/snippet}

{#snippet countActions()}
	{#if snapshot}
		<Button form={`${id}-form`} type="submit" variant="default" disabled={busy || submissionBlocked || admin.status !== 'ready' || !storageReady || wrongIdentity || pendingElsewhere || !paused}><ButtonLabel pending={busy} pendingLabel={m.working} label={ownCommand ? m.retryCount : m.saveCount} reserveLabels={[m.retryCount, m.saveCount]} /></Button>
	{:else if !busy && !command && status !== 'closed' && status !== 'owner'}
		<Button variant="outline" type="button" disabled={admin.status !== 'ready'} onclick={observe}>{status === 'stale' ? m.recount : result ? m.countAgain : m.retryRead}</Button>
	{/if}
{/snippet}

{#if modal}
	<Dialog.Root bind:open={expanded} onOpenChange={(open) => { if (open && !snapshot && !result && status === 'idle') void observe(); }}>
		<Dialog.Trigger disabled={admin.status !== 'ready'}>
			{#snippet child({ props })}<Button {...props} bind:ref={trigger} variant="outline">{ownCommand ? m.retryCount : m.beginCount}</Button>{/snippet}
		</Dialog.Trigger>
		<Dialog.Content forceMount preventScroll={false}
			class="count-dialog max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 data-closed:hidden md:max-w-2xl"
			onCloseAutoFocus={(event) => { event.preventDefault(); trigger?.focus({ preventScroll: true }); }}>
			<Dialog.Header layout="bar" density="compact">
				<div class="min-w-0">
					<Dialog.Title id={`${id}-title`}>{m.countProduct}</Dialog.Title>
					<Dialog.Description class="font-mono">{product.code}</Dialog.Description>
				</div>
				<Dialog.Close>
					{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm" class="shrink-0"><Icon icon={XIcon} /><span class="sr-only">{m.closeCount}</span></Button>{/snippet}
				</Dialog.Close>
			</Dialog.Header>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named count region supports native keyboard scrolling.) -->
			<div class="count-body min-h-0 overflow-y-auto overscroll-contain px-4 py-4" role="region" aria-labelledby={`${id}-title`} tabindex="0">
				<AdminAccessGate>{@render countBody()}</AdminAccessGate>
			</div>
			<Dialog.Footer class="mx-0 mb-0">{@render countActions()}</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{:else}
<section class={section({ spacing: 'divided', class: "count-section" })} aria-labelledby={`${id}-title`}>
	<Separator />
	<h2 class={sectionHeading} id={`${id}-title`}>{m.countProduct}</h2>
	<Collapsible.Root open={expanded} disabled={busy || Boolean(command)} onOpenChange={(open) => { if (open) void observe(); else expanded = false; }}>
		<DisclosureTrigger>{m.beginCount}</DisclosureTrigger>
		<Collapsible.Content id={`${id}-body`}>
			{@render countBody()}
		</Collapsible.Content>
	</Collapsible.Root>
</section>
{/if}
