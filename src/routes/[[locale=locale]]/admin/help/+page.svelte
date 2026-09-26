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
	import { onMount } from 'svelte';
	import { ApiError } from '$lib/api';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { readAdminHelp, staffRequest } from '$lib/admin-api';
	import { identifier, object } from '$lib/api';
	import { parseEditableHelpContact, parseHelpContact, type EditableHelpContact } from '$lib/help';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let contacts = $state<EditableHelpContact[] | null>(null); let busy = $state(false);
	let selected = $state<EditableHelpContact | null>(null); let editing = $state(false);
	let current = $state<EditableHelpContact | null>(null); let reviewFailed = $state(false);
	let reviewId = $state<string | null>(null);
	// Where the editor opens: under the New contact action, or directly under the row being edited.
	let editTarget = $state<string>('new');
	let name = $state(''); let email = $state(''); let phone = $state(''); let url = $state(''); let order = $state('0'); let published = $state(false);
	let outcome = $state<'idle' | 'failed' | 'saved' | 'stale' | 'invalid' | 'unknown'>('idle');
	let storageReady = $state(false); let wrongIdentity = $state(false);
	type ContactWrite = { id: string; display_name: string; email: string | null; phone: string | null; contact_url: string | null; display_order: number; is_published: boolean };
	type Pending = { userId: string; payload: ContactWrite; revision: string | null };
	let pending = $state<Pending | null>(null); const key = 'ampoteket:admin-help-edit:v1';
	function restore(raw: string): Pending {
		const command = object(JSON.parse(raw)); const row = object(command.payload);
		const parsed = parseHelpContact({ ...row, display_order: String(row.display_order) });
		if (typeof row.is_published !== 'boolean' || (command.revision !== null && (typeof command.revision !== 'string' || !/^[1-9]\d*$/.test(command.revision)))) throw new Error();
		return { userId: identifier(command.userId), payload: { ...parsed, is_published: row.is_published }, revision: command.revision as string | null };
	}
	function fields(row: ContactWrite) { name = row.display_name; email = row.email ?? ''; phone = row.phone ?? ''; url = row.contact_url ?? ''; order = String(row.display_order); published = row.is_published; }
	onMount(() => {
		try {
			const raw = sessionStorage.getItem(key); if (raw) pending = restore(raw);
			const probe = key + ':probe'; sessionStorage.setItem(probe, '1'); if (sessionStorage.getItem(probe) !== '1') throw new Error(); sessionStorage.removeItem(probe); storageReady = true;
			if (pending) { wrongIdentity = pending.userId !== admin.session?.user.id; if (!wrongIdentity) { editing = true; editTarget = pending.revision ? pending.payload.id : 'new'; fields(pending.payload); } }
		} catch { storageReady = false; }
		void load();
	});
	async function load() {
		if (busy) return; busy = true; outcome = 'idle'; const session = admin.credentials();
		try { const rows = await readAdminHelp(session); if (session.userId === admin.session?.user.id) contacts = rows; }
		catch (error) { contacts = null; await admin.permissionFailure(error); } finally { busy = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read the list on
	// return to the tab; an open editor keeps its draft and statuses untouched.
	function revalidate() { if (admin.status === 'ready' && document.visibilityState === 'visible' && !busy && !pending && !editing) void load(); }
	function edit(row: EditableHelpContact | null) {
		if (busy || pending) return; selected = row; editing = true; editTarget = row?.id ?? 'new'; outcome = 'idle';
		current = null; reviewFailed = false;
		fields(row ?? { id: '', display_name: '', email: null, phone: null, contact_url: null, display_order: 0, is_published: false });
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
		return row.id === payload.id && row.display_name === payload.display_name && row.email === payload.email && row.phone === payload.phone
			&& row.contact_url === payload.contact_url && row.display_order === payload.display_order && row.is_published === payload.is_published;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault(); if (busy || admin.status !== 'ready' || !storageReady || wrongIdentity || outcome === 'stale') return;
		const session = admin.credentials(); busy = true; outcome = 'idle';
		try {
			if (!pending) {
				let payload: ContactWrite;
				try {
					const contact = parseHelpContact({ id: selected?.id ?? crypto.randomUUID(), display_name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, contact_url: url.trim() || null, display_order: order });
					if (published && !contact.email && !contact.phone && !contact.contact_url) throw new Error();
					payload = { ...contact, is_published: published };
				} catch { outcome = 'invalid'; return; }
				const command: Pending = { userId: session.userId, payload, revision: selected?.edit_revision ?? null };
				const serialized = JSON.stringify(command); sessionStorage.setItem(key, serialized);
				if (sessionStorage.getItem(key) !== serialized) throw new Error(); pending = restore(serialized);
			}
			const saved = restore(sessionStorage.getItem(key) ?? '');
			if (saved.userId !== session.userId || saved.payload.id !== pending.payload.id) throw new Error();
			// Resolve a lost acknowledgement before repeating an insert or guarded edit.
			const found = await staffRequest(session, 'amp_help_contacts', { select: 'id,display_name,email,phone,contact_url,display_order,is_published,edit_revision', id: `eq.${saved.payload.id}`, limit: '2' });
			if (!Array.isArray(found) || found.length > 1) throw new Error();
			let acknowledged: EditableHelpContact | null = found.length ? parseEditableHelpContact(found[0]) : null;
			if (!acknowledged || !sameFields(acknowledged, saved.payload)) {
				if (acknowledged && (saved.revision === null || acknowledged.edit_revision !== saved.revision)) {
					sessionStorage.removeItem(key); pending = null; outcome = 'stale'; reviewId = saved.payload.id; current = null;
					return;
				}
				const result = await staffRequest(session, 'amp_help_contacts', saved.revision ? { id: `eq.${saved.payload.id}`, edit_revision: `eq.${saved.revision}` } : {},
					saved.revision ? { display_name: saved.payload.display_name, email: saved.payload.email, phone: saved.payload.phone, contact_url: saved.payload.contact_url, display_order: saved.payload.display_order, is_published: saved.payload.is_published, edit_revision: saved.revision } : saved.payload,
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
			contacts = await readAdminHelp(session);
		} catch (error) {
			if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
				sessionStorage.removeItem(key); pending = null; outcome = 'invalid';
			} else outcome = pending ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally { busy = false; }
	}
</script>
<svelte:head><title>{m.directoryTitle}</title></svelte:head>
<svelte:window onfocus={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.directoryHeading}</h1>
	<p class={lede}>{m.directoryConsent}</p>
	<div class={formActions}><Button type="button" disabled={busy || Boolean(pending)} onclick={() => edit(null)}>{m.newContact}</Button><Button variant="link" href={i18n.href('/help')}>{m.viewPublic}</Button></div>
</header>
<div class={formStatus} aria-live="polite">
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
					<div><dt>{m.contactEmail}</dt><dd>{current.email ?? '–'}</dd></div>
					<div><dt>{m.contactPhone}</dt><dd>{current.phone ?? '–'}</dd></div>
					<div><dt>{m.contactUrl}</dt><dd>{current.contact_url ?? '–'}</dd></div>
					<div><dt>{m.displayOrder}</dt><dd>{current.display_order}</dd></div>
					<div><dt>{m.publishContact}</dt><dd>{current.is_published ? m.published : m.unpublished}</dd></div>
				</dl>
				<Button type="button" variant="outline" class="justify-self-start" disabled={busy} onclick={useCurrentRevision}>{m.reviewedContact}</Button>
			{/if}
		{/if}
		<form class={formLayout} aria-label={selected || pending?.revision ? m.editHeading : m.newContact} onsubmit={save}>
			<Field.Group layout="row">
				<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.contactName}</Field.Label><Input id={`${fieldId}-1`} required maxlength={120} bind:value={name} disabled={busy || Boolean(pending)} /></Field.Field>
				<Field.Field width="short"><Field.Label for={`${fieldId}-2`}>{m.displayOrder}</Field.Label><Input id={`${fieldId}-2`} type="text" inputmode="numeric" pattern="[0-9]+" required bind:value={order} disabled={busy || Boolean(pending)} /></Field.Field>
			</Field.Group>
			<Field.Group layout="row">
				<Field.Field width="grow"><Field.Label for={`${fieldId}-3`}>{m.contactEmail}</Field.Label><Input id={`${fieldId}-3`} type="email" maxlength={254} bind:value={email} disabled={busy || Boolean(pending)} /></Field.Field>
				<Field.Field width="medium"><Field.Label for={`${fieldId}-4`}>{m.contactPhone}</Field.Label><Input id={`${fieldId}-4`} type="tel" maxlength={40} bind:value={phone} disabled={busy || Boolean(pending)} /></Field.Field>
			</Field.Group>
			<Field.Field width="grow"><Field.Label for={`${fieldId}-5`}>{m.contactUrl}</Field.Label><Input id={`${fieldId}-5`} type="url" maxlength={500} bind:value={url} disabled={busy || Boolean(pending)} /></Field.Field>
			<Field.Field orientation="horizontal"><Switch id="switch-published" name="switch-published" bind:checked={published} disabled={busy || Boolean(pending)} aria-describedby="published-hint" /><Field.Content><Field.Label for="switch-published" class="cursor-pointer">{m.publishContact}</Field.Label><Field.Description id="published-hint">{m.atLeastOneContact}</Field.Description></Field.Content></Field.Field>
			<div class={formActions}>
				<Button type="submit" disabled={busy || !storageReady || outcome === 'stale'}><ButtonLabel pending={busy} pendingLabel={m.working} label={pending ? m.retrySave : m.saveContact} reserveLabels={[m.retrySave, m.saveContact]} /></Button>
				<Button type="button" variant="ghost" disabled={busy || Boolean(pending)} onclick={() => { editing = false; }}>{m.cancel}</Button>
			</div>
		</form>
		<div class={formStatus} aria-live="polite">
			{#if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.operationFailed}</Alert.Message>{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactInvalid}</Alert.Message>{:else if outcome === 'stale'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactStale}</Alert.Message>{:else if outcome === 'saved'}<Alert.Message appearance="inline" variant="default" role="status">{m.contactSaved}</Alert.Message>{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.contactUnknown}</Alert.Message>{/if}
		</div>
	</div>
{/snippet}
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
				<Item.Content class="min-w-0 basis-64">
					<Item.Title class={itemTitle}>{contact.display_name}</Item.Title>
					<Item.Description class="flex flex-wrap items-center gap-x-3 gap-y-1"><StateBadge tone={contact.is_published ? 'success' : 'neutral'}>{contact.is_published ? m.published : m.unpublished}</StateBadge><span>{m.displayOrder}: {contact.display_order}</span></Item.Description>
				</Item.Content>
				<Item.Actions><Button type="button" variant="outline" size="sm" disabled={busy || Boolean(pending)} onclick={() => edit(contact)}>{m.editContact(contact.display_name)}</Button></Item.Actions>
				{#if rowEditor === contact.id}<div class="min-w-0 basis-full pt-2">{@render editor()}</div>{/if}
			</Item.Root>
		{/each}
	</Item.Group>
{/if}
