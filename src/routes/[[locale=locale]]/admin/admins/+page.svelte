<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { clearMemberCommand, memberErrorCode, memberStorageKey, readAdminMembers, readMemberCommand, runMemberCommand, saveMemberCommand, type AdminMember, type MemberCommand } from '$lib/admin-members';
	import { formActions, formLayout, formStatus, itemTitle, lede, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Field from '$lib/components/ui/field';
	import * as Item from '$lib/components/ui/item';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import StateBadge from '$lib/StateBadge.svelte';

	const i18n = getI18n(), admin = getAdminContext(), fieldId = $props.id();
	const m = $derived(i18n.m.adminMembers);
	let members = $state<AdminMember[] | null>(null), loading = $state(false), failed = $state(false);
	let name = $state(''), email = $state(''), busy = $state(false), storageReady = $state(false);
	let pending = $state<MemberCommand | null>(null), confirmId = $state<string | null>(null);
	let outcome = $state<'idle' | 'invited' | 'existing_account' | 'deactivated' | 'deactivationSuperseded' | 'emailFailed' | 'unknown' | 'invalid' | 'superseded' | 'rateLimited' | 'failed' | 'self'>('idle');
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
				if (pending.kind === 'deactivate') confirmId = pending.staffId;
				else if (pending.targetId === null) { name = pending.displayName; email = pending.email; }
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
	function closeConfirmation(id: string) {
		document.getElementById(`${fieldId}-member-${id}`)?.focus({ preventScroll: true }); confirmId = null;
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
			forgetPending(); outcome = result;
		} catch (error) {
			const code = memberErrorCode(error);
			if (code === 'INVITATION_EMAIL_FAILED') outcome = 'emailFailed';
			else if (code === 'RATE_LIMITED') outcome = 'rateLimited';
			else if (['INVALID_ADMIN_INVITATION', 'STAFF_EMAIL_REQUIRED', 'STAFF_DISPLAY_NAME_REQUIRED', 'STAFF_NOT_FOUND', 'STAFF_USER_NOT_FOUND', 'INVITATION_SUPERSEDED', 'STAFF_SELF_DEACTIVATION', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'].includes(code ?? '')) {
				try { forgetPending(); } catch { storageReady = false; }
				outcome = code === 'INVITATION_SUPERSEDED' ? 'superseded' : code === 'STAFF_SELF_DEACTIVATION' ? 'self' : 'invalid';
			} else outcome = pending ? 'unknown' : 'failed';
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
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{i18n.m.admin.commandIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{i18n.m.admin.storageUnavailable}</Alert.Message>{/if}
</div>
<form class={formLayout} aria-label={m.invite} onsubmit={invite}>
	<Field.Group layout="row">
		<Field.Field width="grow"><Field.Label for={`${fieldId}-name`}>{m.name}</Field.Label><Input id={`${fieldId}-name`} required pattern=".*\S.*" maxlength={120} autocapitalize="words" bind:value={name} disabled={locked} /></Field.Field>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-email`}>{i18n.m.admin.email}</Field.Label><Input id={`${fieldId}-email`} type="email" required maxlength={254} enterkeyhint="send" bind:value={email} disabled={locked} /></Field.Field>
	</Field.Group>
	<Button type="submit" disabled={locked}><ButtonLabel pending={busy && outcomeTarget === null} label={m.invite} pendingLabel={i18n.m.admin.working} /></Button>
</form>
{@render feedback(null)}
{#if orphaned}{@render feedback(outcomeTarget)}{/if}

<section class={section()} aria-labelledby={`${fieldId}-accounts`}>
	<h2 id={`${fieldId}-accounts`} class={sectionHeading}>{m.accounts}</h2>
	{#if failed}
		<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>
		<Button type="button" variant="outline" disabled={loading || busy} onclick={load}>{i18n.m.admin.retry}</Button>
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
						<!-- `contents` lets the actions sit beside the name and the confirmation span the row. -->
						<Collapsible.Root class="contents" open={confirmId === member.id} onOpenChange={open => { if (!locked) confirmId = open ? member.id : null; }}>
							<Item.Actions class="flex-wrap">
								{#if member.email && (!member.isActive || !member.emailConfirmed)}
									<Button type="button" variant="outline" size="sm" disabled={locked || failed} onclick={() => inviteMember(member)}><ButtonLabel pending={busy && outcomeTarget === member.id && pending?.kind === 'invite'} label={member.isActive ? m.resend : m.reactivate} pendingLabel={i18n.m.admin.working} /></Button>
								{/if}
								{#if member.isActive || confirmId === member.id}
									<Collapsible.Trigger disabled={locked || failed || !member.isActive}>
										{#snippet child({ props })}<Button {...props} id={`${fieldId}-${member.id}`} type="button" variant="outline" size="sm" aria-label={m.deactivateNamed(member.displayName)}>{m.deactivate}</Button>{/snippet}
									</Collapsible.Trigger>
								{/if}
							</Item.Actions>
							{#if member.isActive || confirmId === member.id}
								<Collapsible.Content class="basis-full space-y-3">
									<p class="text-sm">{m.deactivateHint(member.displayName)}</p>
									<div class={formActions}>
										<Button type="button" variant="destructive" disabled={locked || failed || !member.isActive} onclick={() => deactivate(member)}><ButtonLabel pending={busy && outcomeTarget === member.id && pending?.kind === 'deactivate'} label={m.confirmDeactivate} pendingLabel={i18n.m.admin.working} /></Button>
										<Button type="button" variant="ghost" disabled={busy || pendingTarget === member.id} onclick={() => closeConfirmation(member.id)}>{member.isActive ? i18n.m.admin.cancel : m.close}</Button>
									</div>
								</Collapsible.Content>
							{/if}
						</Collapsible.Root>
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
			<Alert.Message appearance="inline" variant={successful ? 'default' : 'destructive'} role="status">{m.feedback[outcome]}</Alert.Message>
			{#if pending && pendingTarget === target}
				<div class={formActions}>
					<Button type="button" variant="outline" disabled={busy || !storageReady || admin.status !== 'ready'} onclick={() => execute()}><ButtonLabel pending={busy} label={i18n.m.admin.retry} pendingLabel={i18n.m.admin.working} /></Button>
					{#if outcome === 'emailFailed'}<Button type="button" variant="ghost" disabled={busy} onclick={dismissEmailFailure}>{m.close}</Button>{/if}
				</div>
			{/if}
		{/if}
	</div>
{/snippet}
