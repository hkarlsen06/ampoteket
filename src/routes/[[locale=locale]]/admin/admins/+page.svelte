<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { clearMemberCommand, memberFailure, memberStorageKey, readAdminMembers, readMemberCommand, retryableMemberFailures, runMemberCommand, saveMemberCommand, type AdminMember, type MemberCommand, type MemberFailure } from '#lib/admin-members.js';
	import { formActions, formLayout, formStatus, itemTitle, lede, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import StateBadge from '#lib/StateBadge.svelte';

	const i18n = getI18n(), admin = getAdminContext(), fieldId = $props.id();
	const m = $derived(i18n.m.adminMembers);
	let members = $state<AdminMember[] | null>(null), loading = $state(false), failed = $state(false);
	let name = $state(''), email = $state(''), busy = $state(false), storageReady = $state(false);
	let pending = $state<MemberCommand | null>(null);
	let outcome = $state<'idle' | 'invited' | 'existing_account' | 'deactivated' | 'deactivationSuperseded' | 'unknown' | 'failed' | MemberFailure>('idle');
	let outcomeTarget = $state<string | null>(null), revalidateQueued = $state(false);
	let mutationGeneration = 0;
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	const locked = $derived(busy || Boolean(pending) || !storageReady || admin.status !== 'ready');
	const pendingTarget = $derived(pending?.kind === 'deactivate' ? pending.staffId : pending?.targetId ?? null);
	const orphaned = $derived(outcomeTarget !== null && (members !== null || failed) && !members?.some(member => member.id === outcomeTarget));
	const successful = $derived(['invited', 'existing_account', 'deactivated'].includes(outcome));

	onMount(() => {
		try {
			pending = readMemberCommand(sessionStorage);
			const probe = `${memberStorageKey}:probe`; sessionStorage.setItem(probe, '1');
			if (sessionStorage.getItem(probe) !== '1') throw new Error();
			sessionStorage.removeItem(probe); storageReady = true;
			if (pending && pending.userId === admin.session?.user.id) {
				outcomeTarget = pending.kind === 'deactivate' ? pending.staffId : pending.targetId; outcome = 'unknown';
				if (pending.kind === 'invite' && pending.targetId === null) { name = pending.displayName; email = pending.email; }
			}
		} catch { storageReady = false; }
		revalidateQueued = true;
	});
	async function load() {
		if (loading || busy || admin.status !== 'ready') return;
		loading = true;
		const generation = mutationGeneration;
		try {
			const session = admin.credentials(), result = await readAdminMembers(session);
			if (generation !== mutationGeneration) { revalidateQueued = true; return; }
			if (session.userId === admin.session?.user.id) {
				// Access changes must not move existing rows or the controls being used.
				const positions = new Map(members?.map((member, index) => [member.id, index]));
				members = result.sort((a, b) => (positions.get(a.id) ?? positions.size) - (positions.get(b.id) ?? positions.size));
				failed = false;
				if (outcome === 'deactivated' && members.some(member => member.id === outcomeTarget && member.isActive)) outcome = 'deactivationSuperseded';
			}
		} catch (error) { failed = true; await admin.permissionFailure(error); }
		finally { loading = false; }
	}
	function revalidate() { if (document.visibilityState === 'visible') revalidateQueued = true; }
	$effect(() => {
		if (revalidateQueued && !busy && !loading && admin.status === 'ready') {
			revalidateQueued = false; untrack(() => { void load(); });
		}
	});
	// Confirming starts a change that disables, then removes, the deactivate button, however quickly it
	// finishes: focus the row's name instead of the trigger. Cancel still returns focus to the trigger.
	let confirmingId = $state<string | null>(null), confirmedId = $state<string | null>(null);
	function focusMember(id: string, event: Event) {
		if (confirmedId !== id) return;
		confirmedId = null;
		event.preventDefault(); document.getElementById(`${fieldId}-member-${id}`)?.focus({ preventScroll: true });
	}
	function forgetPending() {
		if (!pending) return;
		clearMemberCommand(sessionStorage, pending); pending = null;
	}
	function dismissEmailFailure() {
		try { forgetPending(); outcome = 'idle'; }
		catch { storageReady = false; }
	}
	async function execute(command?: MemberCommand) {
		if (busy || !storageReady || wrongIdentity || admin.status !== 'ready') return;
		busy = true; mutationGeneration++;
		if (!pending) {
			outcome = 'idle'; outcomeTarget = command?.kind === 'deactivate' ? command.staffId : command?.targetId ?? null;
		}
		try {
			if (!pending && command) pending = saveMemberCommand(sessionStorage, command);
			if (!pending) return;
			outcomeTarget = pending.kind === 'deactivate' ? pending.staffId : pending.targetId;
			const session = admin.credentials(), result = await runMemberCommand(session, pending);
			if (session.userId !== admin.session?.user.id) return;
			const finished = pending; forgetPending(); outcome = result;
			// A finished invitation must not be repeatable from the same filled-in form.
			if (finished?.kind === 'invite' && finished.targetId === null) { name = ''; email = ''; }
		} catch (error) {
			const failure = memberFailure(error);
			if (failure && !retryableMemberFailures.includes(failure)) {
				try { forgetPending(); } catch { storageReady = false; }
				outcome = failure;
			} else outcome = failure ?? (pending ? 'unknown' : 'failed');
			await admin.permissionFailure(error);
		} finally { busy = false; revalidateQueued = true; }
	}
	function invite(event: SubmitEvent) {
		event.preventDefault();
		if (locked || !name.trim() || !email.trim()) return;
		void execute({ kind: 'invite', userId: admin.credentials().userId, requestId: crypto.randomUUID(), displayName: name.trim(), email: email.trim(), locale: i18n.locale, targetId: null, targetActive: null });
	}
	function inviteMember(member: AdminMember) {
		if (locked || !member.email) return;
		void execute({ kind: 'invite', userId: admin.credentials().userId, requestId: crypto.randomUUID(), displayName: member.displayName, email: member.email, locale: i18n.locale, targetId: member.id, targetActive: member.isActive });
	}
	function deactivate(member: AdminMember) {
		if (locked) return;
		void execute({ kind: 'deactivate', userId: admin.credentials().userId, requestId: crypto.randomUUID(), staffId: member.id });
	}
</script>

<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<p class={lede}>{m.accessHint}</p>
</header>
<div class={formStatus} aria-live="polite">
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive">{i18n.m.admin.commandIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive">{i18n.m.admin.storageUnavailable}</Alert.Message>{/if}
</div>
<form class={formLayout} aria-label={m.invite} onsubmit={invite}>
	<Field.Group layout="row">
		<Field.Field width="grow"><Field.Label for={`${fieldId}-name`}>{m.name}</Field.Label><Input id={`${fieldId}-name`} required pattern=".*\S.*" maxlength={120} autocapitalize="words" bind:value={name} disabled={locked} /></Field.Field>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-email`}>{i18n.m.admin.email}</Field.Label><Input id={`${fieldId}-email`} type="email" required maxlength={254} enterkeyhint="send" bind:value={email} disabled={locked} /></Field.Field>
	</Field.Group>
	<Button type="submit" disabled={locked}><ButtonLabel pending={busy && outcomeTarget === null} label={m.invite} pendingLabel={m.inviting} /></Button>
</form>
{@render feedback(null)}
{#if orphaned}{@render feedback(outcomeTarget)}{/if}

<section class={section()} aria-labelledby={`${fieldId}-accounts`}>
	<h2 id={`${fieldId}-accounts`} class={sectionHeading}>{m.list}</h2>
	{#if failed}
		<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message>
		<Button type="button" variant="outline" disabled={loading || busy} onclick={load}><ButtonLabel pending={loading} label={i18n.m.admin.retry} pendingLabel={i18n.m.admin.retrying} /></Button>
	{/if}
	{#if members === null}
		<div class="min-h-80 space-y-4" aria-busy={loading}>
			{#if loading}<span class="sr-only" role="status">{i18n.m.admin.loading}</span>{/if}
			{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3" aria-hidden="true"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}
		</div>
	{:else}
		<Item.Group>
			{#each members as member, index (member.id)}
				{#if index > 0}<Item.Separator />{/if}
				<Item.Root variant="row" role="listitem">
					<Item.Content class="min-w-0 basis-64">
						<Item.Title id={`${fieldId}-member-${member.id}`} tabindex={-1} class={[itemTitle, 'flex-wrap']}>{member.displayName}{#if member.authUserId === admin.session?.user.id}<span class="font-normal text-muted-foreground">{m.you}</span>{/if}</Item.Title>
						{#if member.email}<Item.Description class="wrap-anywhere">{member.email}</Item.Description>{/if}
						<div class="flex flex-wrap gap-2"><StateBadge tone={!member.authUserId || !member.isActive ? 'neutral' : member.emailConfirmed ? 'success' : 'warning'}>{!member.authUserId ? m.accountRemoved : !member.isActive ? m.inactive : member.emailConfirmed ? m.active : m.awaitingSetup}</StateBadge></div>
					</Item.Content>
					{#if member.authUserId && member.authUserId !== admin.session?.user.id}
						<Item.Actions class="flex-wrap">
							{#if member.email && (!member.isActive || !member.emailConfirmed)}
								<Button type="button" variant="outline" size="sm" disabled={locked || failed} onclick={() => inviteMember(member)}><ButtonLabel pending={busy && outcomeTarget === member.id && pending?.kind === 'invite'} label={member.isActive ? m.resend : m.reactivate} pendingLabel={member.isActive ? i18n.m.admin.sending : m.activating} /></Button>
							{/if}
							<!-- The dialog outlives the trigger so it can hand focus on after the member turns inactive; the action does not close it by itself. -->
							{#if member.isActive || confirmedId === member.id}
								<AlertDialog.Root open={confirmingId === member.id} onOpenChange={(open) => { confirmingId = open ? member.id : null; }}>
									{#if member.isActive}<AlertDialog.Trigger disabled={locked || failed}>
										{#snippet child({ props })}<Button {...props} id={`${fieldId}-${member.id}`} type="button" variant="outline" size="sm"><ButtonLabel pending={busy && outcomeTarget === member.id && pending?.kind === 'deactivate'} label={m.deactivate} pendingLabel={m.deactivating} /><span class="sr-only"> {m.forMember(member.displayName)}</span></Button>{/snippet}
									</AlertDialog.Trigger>{/if}
									<AlertDialog.Content preventScroll={false} onCloseAutoFocus={event => focusMember(member.id, event)}>
										<AlertDialog.Header>
											<AlertDialog.Title>{m.deactivateNamed(member.displayName)}</AlertDialog.Title>
											<AlertDialog.Description>{m.deactivateHint(member.displayName)}</AlertDialog.Description>
										</AlertDialog.Header>
										<AlertDialog.Footer>
											<AlertDialog.Cancel>{i18n.m.admin.cancel}</AlertDialog.Cancel>
											<AlertDialog.Action variant="destructive" disabled={locked || failed} onclick={() => { confirmedId = member.id; confirmingId = null; deactivate(member); }}>{m.confirmDeactivate}</AlertDialog.Action>
										</AlertDialog.Footer>
									</AlertDialog.Content>
								</AlertDialog.Root>
							{/if}
						</Item.Actions>
					{/if}
					<div class="min-w-0 basis-full">{@render feedback(member.id)}</div>
				</Item.Root>
			{/each}
		</Item.Group>
	{/if}
</section>

{#snippet feedback(target: string | null)}
	<div class={formStatus} aria-live="polite">
		{#if outcomeTarget === target && outcome !== 'idle' && !wrongIdentity}
			<Alert.Message appearance="inline" variant={successful ? 'default' : 'destructive'}>{m.feedback[outcome]}</Alert.Message>
			{#if pending && pendingTarget === target}
				<div class={formActions}>
					<Button type="button" variant="outline" disabled={busy || !storageReady || admin.status !== 'ready'} onclick={() => execute()}><ButtonLabel pending={busy} label={i18n.m.admin.retry} pendingLabel={i18n.m.admin.retrying} /></Button>
					{#if outcome === 'emailFailed'}<Button type="button" variant="ghost" disabled={busy} onclick={dismissEmailFailure}>{m.close}</Button>{/if}
				</div>
			{/if}
		{/if}
	</div>
{/snippet}
