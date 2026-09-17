<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formLayout, formStatus, itemTitle, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import { Input } from '$lib/components/ui/input';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import StateBadge from '$lib/StateBadge.svelte';
	import * as Field from '$lib/components/ui/field';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { formatCountedAt } from '$lib/format';
	import { clearCountCommand, countBatchAccess, countCommandPath, countStorageEvent, readCountBatches, readCountCommand, runCountCommand, saveCountCommand, updateCountStorage, type CountBatch, type CountCommand, type CountOwner } from '$lib/admin-counts';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminCounts);
	let batches = $state<CountBatch[]>([]); let owners = $state<CountOwner[]>([]); let title = $state('');
	let loaded = $state(false); let loading = $state(true); let failed = $state(false); let busy = $state(false); let storageReady = $state(false);
	let command = $state<CountCommand | null>(null); let outcome = $state<'idle' | 'failed' | 'unknown'>('idle'); let mounted = false; let generation = 0;
	const wrongIdentity = $derived(Boolean(command && command.userId !== admin.session?.user.id));
	const batchTone = { owner: 'success', other: 'neutral', abandoned: 'warning', finished: 'neutral' } as const;
	onMount(() => {
		mounted = true;
		function syncPending() { if (busy) return; try { command = readCountCommand(localStorage); if (command?.kind === 'start') { title = command.title; outcome = 'unknown'; } } catch { storageReady = false; } }
		syncPending();
		void updateCountStorage((storage) => { readCountCommand(storage); const key = 'ampoteket:count-storage-check'; storage.setItem(key, '1'); if (storage.getItem(key) !== '1') throw new Error(); storage.removeItem(key); }).then(() => { if (mounted) storageReady = true; }).catch(() => { if (mounted) storageReady = false; });
		window.addEventListener('storage', syncPending); window.addEventListener(countStorageEvent, syncPending); void load();
		return () => { mounted = false; generation++; window.removeEventListener('storage', syncPending); window.removeEventListener(countStorageEvent, syncPending); };
	});
	async function load() {
		loading = true; failed = false; const version = ++generation; const session = admin.credentials();
		try { const result = await readCountBatches(session); if (mounted && version === generation && admin.session?.user.id === session.userId) { batches = result.batches; owners = result.owners; loaded = true; } }
		catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read on return to the
	// tab instead of offering a manual refresh button.
	function revalidate() { if (admin.status === 'ready' && document.visibilityState === 'visible' && !loading) void load(); }
	async function start(event: SubmitEvent) {
		event.preventDefault(); if (busy || !storageReady || wrongIdentity || (command && command.kind !== 'start') || !title.trim()) return;
		busy = true; outcome = 'idle'; const session = admin.credentials();
		const candidate: CountCommand = command ?? { kind: 'start', userId: session.userId, requestId: crypto.randomUUID(), title: title.trim() };
		let frozen: CountCommand | null = null;
		try {
			frozen = await updateCountStorage((storage) => saveCountCommand(storage, candidate)); command = frozen;
			const result = await runCountCommand(session, frozen);
			await updateCountStorage((storage) => clearCountCommand(storage, frozen!));
			if (mounted && admin.session?.user.id === session.userId) { command = null; await goto(i18n.href(`/admin/counts/${result.batchId}`)); }
		} catch (error) { if (mounted) outcome = frozen ? 'unknown' : 'failed'; await admin.permissionFailure(error); }
		finally { if (mounted) busy = false; }
	}
</script>

<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>
<section class="space-y-4" aria-labelledby="start-count-title">
	<h2 class={sectionHeading} id="start-count-title">{m.startHeading}</h2>
	<form class={formLayout} onsubmit={start}>
		<Field.Group layout="row">
			<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.batchTitle}</Field.Label><Input id={`${fieldId}-1`} required maxlength={200} autocomplete="off" enterkeyhint="go" bind:value={title} disabled={busy || Boolean(command)} /></Field.Field>
			<Button type="submit" variant="default" disabled={busy || !storageReady || wrongIdentity || (command !== null && command.kind !== 'start') || !title.trim()}><ButtonLabel pending={busy} pendingLabel={m.working} label={command?.kind === 'start' ? m.retryStart : m.start} reserveLabels={[m.retryStart, m.start]} /></Button>
		</Field.Group>
	</form>
	<div class={formStatus} aria-live="polite">
		{#if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
		{:else if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
		{:else if command && command.kind !== 'start'}<Alert.Message appearance="inline" variant="default" role="status">{m.pendingElsewhere}</Alert.Message>
		{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unknownStart}</Alert.Message>
		{:else if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}
	</div>
	{#if storageReady && !wrongIdentity && command && command.kind !== 'start'}<Button variant="link" href={i18n.href(countCommandPath(command))}>{m.resumePending}</Button>{/if}
</section>
<section class={section({ spacing: 'divided' })} aria-labelledby="count-list-title">
	<Separator />
	<h2 class={sectionHeading} id="count-list-title">{m.batches}</h2>
	<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
	{#if failed}<Button variant="outline" type="button" disabled={loading} onclick={load}>{m.retryLoad}</Button>
	{:else if loaded && !batches.length}<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>{/if}
	{#if loading && !loaded}
		<span class="sr-only" role="status">{m.loading}</span>
		<div class="min-h-64 space-y-6" aria-busy="true" aria-hidden="true">{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}</div>
	{/if}
	{#if !failed}
		<Item.Group class="batch-list">
			{#each batches as batch, index (batch.id)}
				{#if index > 0}<Item.Separator />{/if}
				{@const owner = owners.find((owner) => owner.id === batch.ownerId)!}
				{@const access = countBatchAccess(batch, owner, admin.membership!.id)}
				<Item.Root variant="row" role="listitem">
					<Item.Content class="min-w-0 basis-72">
						<Item.Title><h3 class={itemTitle}><a class="text-foreground no-underline hover:underline" href={i18n.href(`/admin/counts/${batch.id}`)}>{batch.title}</a></h3></Item.Title>
						<Item.Description>{m.owner}: {owner.name} · {m.started(formatCountedAt(batch.startedAt, i18n.locale))}</Item.Description>
					</Item.Content>
					<Item.Actions><StateBadge tone={batchTone[access]}>{m.batchStates[access]}</StateBadge></Item.Actions>
				</Item.Root>
			{/each}
		</Item.Group>
	{/if}
</section>
