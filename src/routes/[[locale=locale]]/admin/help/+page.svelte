<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formActions, formLayout, formStatus, itemTitle, lede, pageHeader, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import StateBadge from '$lib/StateBadge.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import * as Field from '$lib/components/ui/field';
	import Icon from '$lib/Icon.svelte';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
	import { untrack, onMount, tick } from 'svelte';
	import { ApiError } from '$lib/api';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { readAdminHelp, reorderHelpContacts, staffRequest } from '$lib/admin-api';
	import { identifier, object } from '$lib/api';
	import { parseEditableHelpContact, parseHelpContact, reachable, type EditableHelpContact } from '$lib/help';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let failed = $state(false); let contacts = $state<EditableHelpContact[] | null>(null); let busy = $state(false);
	let selected = $state<EditableHelpContact | null>(null); let editing = $state(false);
	let current = $state<EditableHelpContact | null>(null); let reviewFailed = $state(false);
	let reviewId = $state<string | null>(null);
	// Where the editor opens: under the New contact action, or directly under the row being edited.
	let editTarget = $state<string>('new');
	let name = $state(''); let responsibility = $state(''); let discord = $state(''); let email = $state(''); let phone = $state(''); let url = $state(''); let published = $state(false);
	let outcome = $state<'idle' | 'failed' | 'saved' | 'stale' | 'invalid' | 'unknown'>('idle');
	let storageReady = $state(false); let wrongIdentity = $state(false);
	// Order is not part of an edit: rows are moved with amp_reorder_help_contacts.
	type ContactWrite = { id: string; display_name: string; responsibility: string | null; email: string | null; phone: string | null; contact_url: string | null; discord: string | null; is_published: boolean };
	function contactWrite(value: Record<string, unknown>, is_published: boolean): ContactWrite {
		// Drafts saved before the Discord migration carry neither field, and older ones still carry an order.
		const c = parseHelpContact({ responsibility: null, discord: null, ...value, display_order: '0' });
		return { id: c.id, display_name: c.display_name, responsibility: c.responsibility, email: c.email, phone: c.phone, contact_url: c.contact_url, discord: c.discord, is_published };
	}
	type Pending = { userId: string; payload: ContactWrite; revision: string | null };
	let pending = $state<Pending | null>(null); const key = 'ampoteket:admin-help-edit:v1';
	function restore(raw: string): Pending {
		const command = object(JSON.parse(raw)); const row = object(command.payload);
		if (typeof row.is_published !== 'boolean' || (command.revision !== null && (typeof command.revision !== 'string' || !/^[1-9]\d*$/.test(command.revision)))) throw new Error();
		return { userId: identifier(command.userId), payload: contactWrite(row, row.is_published), revision: command.revision as string | null };
	}
	function fields(row: ContactWrite) { name = row.display_name; responsibility = row.responsibility ?? ''; discord = row.discord ?? ''; email = row.email ?? ''; phone = row.phone ?? ''; url = row.contact_url ?? ''; published = row.is_published; }
	onMount(() => {
		try {
			const raw = sessionStorage.getItem(key); if (raw) pending = restore(raw);
			const probe = key + ':probe'; sessionStorage.setItem(probe, '1'); if (sessionStorage.getItem(probe) !== '1') throw new Error(); sessionStorage.removeItem(probe); storageReady = true;
			if (pending) { wrongIdentity = pending.userId !== admin.session?.user.id; if (!wrongIdentity) { editing = true; editTarget = pending.revision ? pending.payload.id : 'new'; fields(pending.payload); } }
		} catch { storageReady = false; }
		void load();
	});
	async function load() {
		if (admin.status !== 'ready') return;
		if (busy || moving || admin.status !== 'ready') return; busy = true; outcome = 'idle';
		try {
			const session = admin.credentials(); const rows = await readAdminHelp(session); if (session.userId === admin.session?.user.id) { contacts = rows; failed = false; } }
		catch (error) { failed = true; await admin.permissionFailure(error); } finally { busy = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read the list on
	// return to the tab; an open editor keeps its draft and statuses untouched.
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(busy || moving || editing || Boolean(pending))) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	function edit(row: EditableHelpContact | null) {
		if (failed || busy || pending) return; selected = row; editing = true; editTarget = row?.id ?? 'new'; outcome = 'idle';
		current = null; reviewFailed = false;
		fields(row ?? { id: '', display_name: '', responsibility: null, email: null, phone: null, contact_url: null, discord: null, is_published: false });
	}
	async function review() {
		if (busy || !reviewId || admin.status !== 'ready') return;
		busy = true; reviewFailed = false; current = null;
		try {
			const rows = await readAdminHelp(admin.credentials());
			contacts = rows;
			current = rows.find(contact => contact.id === reviewId) ?? null;
			if (!current) reviewFailed = true;
		} catch (error) { reviewFailed = true; await admin.permissionFailure(error); }
		finally { busy = false; }
	}
	function useCurrentRevision() {
		if (busy || !current) return;
		selected = current; current = null; outcome = 'idle';
	}
	const rowEditor = $derived(editing && !wrongIdentity && contacts?.some(contact => contact.id === editTarget) ? editTarget : null);
	function sameFields(row: EditableHelpContact, payload: ContactWrite) {
		return row.id === payload.id && row.display_name === payload.display_name && row.responsibility === payload.responsibility && row.discord === payload.discord && row.email === payload.email && row.phone === payload.phone
			&& row.contact_url === payload.contact_url && row.is_published === payload.is_published;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault(); if (failed || busy || admin.status !== 'ready' || !storageReady || wrongIdentity || outcome === 'stale') return;
		busy = true; outcome = 'idle';
		try {
			const session = admin.credentials();
			if (!pending) {
				let payload: ContactWrite;
				try {
					payload = contactWrite({ id: selected?.id ?? crypto.randomUUID(), display_name: name.trim(), responsibility: responsibility.trim() || null, discord: discord.trim() || null, email: email.trim() || null, phone: phone.trim() || null, contact_url: url.trim() || null }, published);
					if (published && !reachable(payload)) throw new Error();
				} catch { outcome = 'invalid'; return; }
				const command: Pending = { userId: session.userId, payload, revision: selected?.edit_revision ?? null };
				const serialized = JSON.stringify(command); sessionStorage.setItem(key, serialized);
				if (sessionStorage.getItem(key) !== serialized) throw new Error(); pending = restore(serialized);
			}
			const saved = restore(sessionStorage.getItem(key) ?? '');
			if (saved.userId !== session.userId || saved.payload.id !== pending.payload.id) throw new Error();
			// Resolve a lost acknowledgement before repeating an insert or guarded edit.
			const found = await staffRequest(session, 'amp_help_contacts', { select: 'id,display_name,responsibility,email,phone,contact_url,discord,display_order,is_published,edit_revision', id: `eq.${saved.payload.id}`, limit: '2' });
			if (!Array.isArray(found) || found.length > 1) throw new Error();
			let acknowledged: EditableHelpContact | null = found.length ? parseEditableHelpContact(found[0]) : null;
			if (!acknowledged || !sameFields(acknowledged, saved.payload)) {
				if (acknowledged && (saved.revision === null || acknowledged.edit_revision !== saved.revision)) {
					sessionStorage.removeItem(key); pending = null; outcome = 'stale'; reviewId = saved.payload.id; current = null;
					return;
				}
				const result = await staffRequest(session, 'amp_help_contacts', saved.revision ? { id: `eq.${saved.payload.id}`, edit_revision: `eq.${saved.revision}` } : {},
					saved.revision ? { display_name: saved.payload.display_name, responsibility: saved.payload.responsibility, discord: saved.payload.discord, email: saved.payload.email, phone: saved.payload.phone, contact_url: saved.payload.contact_url, is_published: saved.payload.is_published, edit_revision: saved.revision } : saved.payload,
					saved.revision ? 'PATCH' : 'POST');
				if (!Array.isArray(result) || result.length > 1) throw new Error();
				if (!result.length) {
					sessionStorage.removeItem(key); pending = null; outcome = 'stale'; reviewId = saved.payload.id; current = null;
					return;
				}
				acknowledged = parseEditableHelpContact(result[0]);
				if (!sameFields(acknowledged, saved.payload)) throw new Error();
			}
			if (admin.session?.user.id !== session.userId) return;
			sessionStorage.removeItem(key); pending = null; selected = acknowledged; fields(acknowledged); outcome = 'saved';
			try { contacts = await readAdminHelp(session); failed = false; }
			catch (error) { failed = true; await admin.permissionFailure(error); }
		} catch (error) {
			if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
				sessionStorage.removeItem(key); pending = null; outcome = 'invalid';
			} else outcome = pending ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally { busy = false; }
	}
	// Moves show at once and save in the background; focus stays on the moved row.
	let moving = $state(false); let moveFailure = $state<'stale' | 'failed' | null>(null); let moveAnnouncement = $state('');
	async function move(index: number, step: -1 | 1) {
		if (!contacts || moving || busy || failed || admin.status !== 'ready') return;
		const previous = contacts; const next = [...previous]; const target = index + step;
		const [row] = next.splice(index, 1); next.splice(target, 0, row);
		moving = true; moveFailure = null; moveAnnouncement = ''; contacts = next;
		await tick();
		// At the top or bottom the pressed button is disabled, so focus its partner.
		const edge = step < 0 ? target === 0 : target === next.length - 1;
		document.querySelector<HTMLButtonElement>(`[data-move="${row.id}:${(step < 0) !== edge ? 'up' : 'down'}"]`)?.focus();
		try {
			await reorderHelpContacts(admin.credentials(), next.map(contact => contact.id), previous.map(contact => contact.id));
			moveAnnouncement = m.contactMoved(row.display_name, target + 1, next.length);
		} catch (error) {
			contacts = previous;
			moveFailure = error instanceof ApiError && JSON.stringify(error.body).includes('STALE_HELP_ORDER') ? 'stale' : 'failed';
			await admin.permissionFailure(error);
		} finally { moving = false; }
		if (moveFailure === 'stale') await load();
	}
</script>
<svelte:head><title>{m.directoryTitle}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.directoryHeading}</h1>
	<p class={lede}>{m.directoryConsent}</p>
	<div class={formActions}><Button type="button" disabled={failed || busy || Boolean(pending)} onclick={() => edit(null)}>{m.newContact}</Button><Button variant="link" href={i18n.href('/help')}>{m.viewPublic}</Button></div>
</header>
<div class={formStatus} aria-live="polite">
	{#if moveFailure}<Alert.Message appearance="inline" variant="destructive" role="status">{moveFailure === 'stale' ? m.orderStale : m.operationFailed}</Alert.Message>{/if}
	<span class="sr-only">{moveAnnouncement}</span>
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.commandIdentity}</Alert.Message>{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>{/if}
</div>
{#if editing && !wrongIdentity && rowEditor === null}<div class="mb-8">{@render editor()}</div>{/if}
{#snippet editor()}
	<div class="grid gap-4">
		{#if outcome === 'stale'}
			<Button type="button" variant="outline" class="justify-self-start" disabled={busy} onclick={review}>{m.reviewContact}</Button>
			{#if reviewFailed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}
			{#if current}
				<dl class="grid gap-3 md:grid-cols-2 [&_dt]:text-sm [&_dt]:text-muted-foreground [&_dd]:wrap-anywhere">
					<div><dt>{m.contactName}</dt><dd>{current.display_name}</dd></div>
					<div><dt>{m.contactResponsibility}</dt><dd>{current.responsibility ?? '–'}</dd></div>
					<div><dt>{m.contactDiscord}</dt><dd>{current.discord ?? '–'}</dd></div>
					<div><dt>{m.contactEmail}</dt><dd>{current.email ?? '–'}</dd></div>
					<div><dt>{m.contactPhone}</dt><dd>{current.phone ?? '–'}</dd></div>
					<div><dt>{m.contactUrl}</dt><dd>{current.contact_url ?? '–'}</dd></div>
					<div><dt>{m.publishContact}</dt><dd>{current.is_published ? m.published : m.unpublished}</dd></div>
				</dl>
				<Button type="button" variant="outline" class="justify-self-start" disabled={busy} onclick={useCurrentRevision}>{m.reviewedContact}</Button>
			{/if}
		{/if}
		<form class={formLayout} aria-label={selected || pending?.revision ? m.editHeading : m.newContact} onsubmit={save}>
			<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.contactName}</Field.Label><Input id={`${fieldId}-1`} autocapitalize="words" required maxlength={120} bind:value={name} disabled={busy || Boolean(pending)} /></Field.Field>
			<Field.Group layout="row">
				<Field.Field width="grow"><Field.Label for={`${fieldId}-6`}>{m.contactResponsibility}</Field.Label><Input id={`${fieldId}-6`} maxlength={80} bind:value={responsibility} disabled={busy || Boolean(pending)} /></Field.Field>
				<Field.Field width="medium"><Field.Label for={`${fieldId}-7`}>{m.contactDiscord}</Field.Label><Input id={`${fieldId}-7`} autocapitalize="none" autocomplete="off" spellcheck="false" maxlength={32} bind:value={discord} disabled={busy || Boolean(pending)} /></Field.Field>
			</Field.Group>
			<Field.Group layout="row">
				<Field.Field width="grow"><Field.Label for={`${fieldId}-3`}>{m.contactEmail}</Field.Label><Input id={`${fieldId}-3`} type="email" maxlength={254} bind:value={email} disabled={busy || Boolean(pending)} /></Field.Field>
				<Field.Field width="medium"><Field.Label for={`${fieldId}-4`}>{m.contactPhone}</Field.Label><Input id={`${fieldId}-4`} type="tel" maxlength={40} bind:value={phone} disabled={busy || Boolean(pending)} /></Field.Field>
			</Field.Group>
			<Field.Field width="grow"><Field.Label for={`${fieldId}-5`}>{m.contactUrl}</Field.Label><Input id={`${fieldId}-5`} type="url" autocapitalize="none" enterkeyhint="go" maxlength={500} bind:value={url} disabled={busy || Boolean(pending)} /></Field.Field>
			<Field.Field orientation="horizontal"><Switch id="switch-published" name="switch-published" bind:checked={published} disabled={busy || Boolean(pending)} aria-describedby="published-hint" /><Field.Content><Field.Label for="switch-published" class="cursor-pointer">{m.publishContact}</Field.Label><Field.Description id="published-hint">{m.atLeastOneContact}</Field.Description></Field.Content></Field.Field>
			<div class={formActions}>
				<Button type="submit" disabled={failed || busy || !storageReady || outcome === 'stale'}><ButtonLabel pending={busy} pendingLabel={m.working} label={pending ? m.retrySave : m.saveContact} reserveLabels={[m.retrySave, m.saveContact]} /></Button>
				<Button type="button" variant="ghost" disabled={busy || Boolean(pending)} onclick={() => { editing = false; }}>{m.cancel}</Button>
			</div>
		</form>
		<div class={formStatus} aria-live="polite">
			{#if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.operationFailed}</Alert.Message>{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactInvalid}</Alert.Message>{:else if outcome === 'stale'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactStale}</Alert.Message>{:else if outcome === 'saved'}<Alert.Message appearance="inline" variant="default" role="status">{m.contactSaved}</Alert.Message>{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactUnknown}</Alert.Message>{/if}
		</div>
	</div>
{/snippet}
{#if failed && contacts !== null}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" disabled={busy} onclick={load}>{m.retry}</Button>{/if}
{#if contacts === null}
	{#if busy}<span class="sr-only" role="status">{m.loading}</span>{/if}
	<div class="min-h-80 space-y-4" aria-busy={busy}>
		{#if busy}{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3" aria-hidden="true"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}
		{:else}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load}>{m.retry}</Button>{/if}
	</div>
{:else if !contacts.length}<Empty.Root><Empty.Description>{m.noDirectoryContacts}</Empty.Description></Empty.Root>
{:else}
	<Item.Group class="contact-list">
		{#each contacts as contact, index (contact.id)}
			{#if index > 0}<Item.Separator />{/if}
			<Item.Root variant="row" role="listitem">
				<!-- A fixed column, so the arrows stay under the pointer from row to row. -->
				<div class="-my-1 flex shrink-0 flex-col self-start">
					<Button type="button" variant="ghost" size="icon-sm" data-move={`${contact.id}:up`} disabled={failed || index === 0} onclick={() => move(index, -1)}><Icon icon={ArrowUpIcon} /><span class="sr-only">{m.moveContactUp(contact.display_name)}</span></Button>
					<Button type="button" variant="ghost" size="icon-sm" data-move={`${contact.id}:down`} disabled={failed || index === contacts.length - 1} onclick={() => move(index, 1)}><Icon icon={ArrowDownIcon} /><span class="sr-only">{m.moveContactDown(contact.display_name)}</span></Button>
				</div>
				<Item.Content class="min-w-0 basis-48">
					<Item.Title class={itemTitle}>{contact.display_name}</Item.Title>
					<Item.Description class="flex flex-wrap items-center gap-x-3 gap-y-1"><StateBadge tone={contact.is_published ? 'success' : 'neutral'}>{contact.is_published ? m.published : m.unpublished}</StateBadge>{#if contact.responsibility}<span>{contact.responsibility}</span>{/if}</Item.Description>
				</Item.Content>
				<Item.Actions><Button type="button" variant="outline" size="sm" disabled={busy || failed || Boolean(pending)} onclick={() => edit(contact)}>{m.editContact(contact.display_name)}</Button></Item.Actions>
				{#if rowEditor === contact.id}<div class="min-w-0 basis-full pt-2">{@render editor()}</div>{/if}
			</Item.Root>
		{/each}
	</Item.Group>
{/if}
