<script lang="ts">
	import { formStatus } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import AdminAuthCard from '#lib/AdminAuthCard.svelte';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext, adminReturnPath } from '#lib/admin-context.svelte.js';
	import { signInFailure, type SignInFailure } from '#lib/admin-auth.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let email = $state(''); let password = $state(''); let busy = $state(false); let failure = $state<SignInFailure | null>(null);
	const next = $derived(adminReturnPath(page.url.searchParams.get('next')));
	const denied = $derived(admin.status === 'noAccess' || admin.status === 'revoked');
	async function signIn(event: SubmitEvent) {
		event.preventDefault(); if (!admin.auth || busy) return;
		busy = true; failure = null;
		try {
			const { error } = await admin.auth.signInWithPassword({ email: email.trim(), password });
			password = ''; if (error) throw error;
			await admin.refresh();
			if (admin.status === 'ready') await goto(i18n.href(next));
		} catch (error) { failure = signInFailure(error); } finally { busy = false; }
	}
</script>
<svelte:head><title>{m.signInTitle}</title></svelte:head>
<AdminAuthCard heading={m.signIn} lede={admin.status === 'ready' || denied ? undefined : m.signInRequired}>
	{#if denied}
		<Alert.Message appearance="inline" variant="destructive" role="alert">{admin.status === 'revoked' ? m.revoked : m.noAccess}</Alert.Message>
		<Button type="button" variant="outline" class="justify-self-start" onclick={() => admin.signOut()}>{m.signOut}</Button>
	{:else if admin.status === 'ready'}
		<p>{m.signedInAs(admin.membership?.displayName ?? '')}</p>
		<Button variant="default" class="w-full" href={i18n.href(next)}>{m.continue}</Button>
	{:else}
		<form class="grid gap-5" onsubmit={signIn}>
			<Field.Field><Field.Label for={`${fieldId}-1`}>{m.email}</Field.Label><Input id={`${fieldId}-1`} type="email" autocomplete="username" required bind:value={email} disabled={busy} /></Field.Field>
			<Field.Field><Field.Label for={`${fieldId}-2`}>{m.password}</Field.Label><Input id={`${fieldId}-2`} type="password" autocomplete="current-password" enterkeyhint="go" required bind:value={password} disabled={busy} /></Field.Field>
			<Button type="submit" variant="default" class="w-full" disabled={busy || !admin.auth}><ButtonLabel pending={busy} pendingLabel={m.signingIn} label={m.signIn} /></Button>
			<Button variant="link" class="justify-self-start" href={i18n.href(`/admin/password?next=${encodeURIComponent(next)}`)}>{m.forgotPassword}</Button>
		</form>
		<div class={formStatus} aria-live="polite">{#if failure}<Alert.Message appearance="inline" variant="destructive">{m.signInErrors[failure]}</Alert.Message>{:else if admin.status === 'unavailable'}<Alert.Message appearance="inline" variant="destructive">{m.accessUnavailable}</Alert.Message>{/if}</div>
		{#if admin.status === 'unavailable'}<Button type="button" variant="outline" class="justify-self-start" onclick={() => admin.refresh()}>{m.retry}</Button>{/if}
	{/if}
</AdminAuthCard>
