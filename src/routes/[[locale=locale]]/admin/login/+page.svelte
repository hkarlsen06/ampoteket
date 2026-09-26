<script lang="ts">
	import { formActions, formLayout, formStatus, pageHeader, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext, adminReturnPath } from '$lib/admin-context.svelte';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let email = $state(''); let password = $state(''); let busy = $state(false); let failed = $state(false);
	const next = $derived(adminReturnPath(page.url.searchParams.get('next')));
	async function signIn(event: SubmitEvent) {
		event.preventDefault(); if (!admin.auth || busy) return;
		busy = true; failed = false;
		try {
			const { error } = await admin.auth.signInWithPassword({ email: email.trim(), password });
			password = ''; if (error) throw error;
			await admin.refresh();
			if (admin.status === 'ready') await goto(i18n.href(next));
		} catch { failed = true; } finally { busy = false; }
	}
</script>
<svelte:head><title>{m.signInTitle}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{m.signIn}</h1></header>
{#if admin.status === 'noAccess' || admin.status === 'revoked'}
	<div class={formLayout}>
		<Alert.Message appearance="inline" role="status">{admin.status === 'revoked' ? m.revoked : m.noAccess}</Alert.Message>
		<Button type="button" variant="outline" onclick={() => admin.signOut()}>{m.signOut}</Button>
	</div>
{:else if admin.status === 'ready'}
	<div class={formLayout}><p>{m.signedInAs(admin.membership?.displayName ?? '')}</p><Button variant="default" href={i18n.href(next)}>{m.continue}</Button></div>
{:else}
	<form class={[formLayout, "max-w-md"]} onsubmit={signIn}>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.email}</Field.Label><Input id={`${fieldId}-1`} type="email" autocomplete="username" required bind:value={email} disabled={busy} /></Field.Field>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-2`}>{m.password}</Field.Label><Input id={`${fieldId}-2`} type="password" autocomplete="current-password" enterkeyhint="go" required bind:value={password} disabled={busy} /></Field.Field>
		<div class={formActions}><Button type="submit" variant="default" disabled={busy || !admin.auth}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.signIn} /></Button><Button variant="link" href={i18n.href(`/admin/password?next=${encodeURIComponent(next)}`)}>{m.forgotPassword}</Button></div>
	</form>
	<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.signInFailed}</Alert.Message>{:else if admin.status === 'unavailable'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
{/if}
