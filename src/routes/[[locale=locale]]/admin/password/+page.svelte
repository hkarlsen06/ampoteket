<script lang="ts">
	import { formStatus } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import AdminAuthCard from '#lib/AdminAuthCard.svelte';
	import StateBadge from '#lib/StateBadge.svelte';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { onMount } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext, adminReturnPath } from '#lib/admin-context.svelte.js';
	import { passwordLinkToken } from '#lib/admin-auth.js';
	import { api, errorCode } from '#lib/convex.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let email = $state(''); let password = $state(''); let repeat = $state(''); let busy = $state(false);
	let status = $state<'idle' | 'sent' | 'failed' | 'invalid' | 'saved' | 'mismatch'>('idle');
	/** A link not yet opened, and one checked as usable. */
	let callback = $state<string | null>(null);
	let verifiedToken = $state<string | null>(null); let next = $state('/admin');
	onMount(() => {
		const url = new URL(window.location.href); next = adminReturnPath(url.searchParams.get('next'));
		const link = passwordLinkToken(url);
		// Discard the link's token before any in-page link can copy it.
		history.replaceState(history.state, '', i18n.href('/admin/password'));
		if (link === 'invalid') status = 'invalid';
		else if (link) callback = link.token;
	});
	// Wait for a click, as with the old links; opening a link consumes nothing, setting the password does.
	async function exchange() {
		if (!callback || !admin.client || busy) return; busy = true;
		try {
			const { valid } = await admin.client.query(api.passwords.checkLink, { token: callback });
			if (!valid) throw new Error();
			verifiedToken = callback;
		} catch { status = 'invalid'; } finally { callback = null; busy = false; }
	}
	async function send(event: SubmitEvent) {
		event.preventDefault(); if (!admin.client || busy) return; busy = true; status = 'idle';
		try { await admin.client.action(api.passwords.requestReset, { email: email.trim(), locale: i18n.locale }); status = 'sent'; }
		catch { status = 'failed'; } finally { busy = false; }
	}
	async function save(event: SubmitEvent) {
		event.preventDefault(); if (!admin.client || busy || !verifiedToken) return;
		if (password !== repeat) { status = 'mismatch'; return; } busy = true; status = 'idle';
		try {
			const account = await admin.client.mutation(api.passwords.complete, { token: verifiedToken, password });
			verifiedToken = null;
			await admin.signIn(account.email, password);
			password = ''; repeat = ''; status = 'saved';
		} catch (error) {
			if (errorCode(error) === 'INVALID_PASSWORD_LINK') { verifiedToken = null; status = 'invalid'; } else status = 'failed';
		} finally { busy = false; }
	}
</script>
<svelte:head><title>{m.passwordTitle}</title></svelte:head>
<AdminAuthCard heading={m.passwordHeading}>
	{#if status === 'saved'}
		<Button variant="default" class="w-full" href={i18n.href(next)}>{m.continueToAdmin}</Button>
	{:else if callback}
		<Button variant="default" class="w-full" onclick={exchange} disabled={busy || !admin.client}><ButtonLabel pending={busy} pendingLabel={m.continuing} label={m.continue} /></Button>
	{:else if verifiedToken}
		<form class="grid gap-5" onsubmit={save}>
			<Field.Field><Field.Label for={`${fieldId}-1`}>{m.newPassword}</Field.Label><Input id={`${fieldId}-1`} type="password" autocomplete="new-password" minlength={8} required aria-describedby={`${fieldId}-hint`} bind:value={password} disabled={busy} /><Field.Description id={`${fieldId}-hint`}>{m.passwordHint}</Field.Description></Field.Field>
			<Field.Field><Field.Label for={`${fieldId}-2`}>{m.repeatPassword}</Field.Label><Input id={`${fieldId}-2`} type="password" autocomplete="new-password" enterkeyhint="go" minlength={8} required bind:value={repeat} disabled={busy} /></Field.Field>
			<Button type="submit" variant="default" class="w-full" disabled={busy}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.savePassword} /></Button>
		</form>
	{:else}
		<form class="grid gap-5" onsubmit={send}>
			<Field.Field><Field.Label for={`${fieldId}-3`}>{m.email}</Field.Label><Input id={`${fieldId}-3`} type="email" autocomplete="username" enterkeyhint="send" required bind:value={email} disabled={busy} /></Field.Field>
			<Button type="submit" variant="default" class="w-full" disabled={busy || !admin.client}><ButtonLabel pending={busy} pendingLabel={m.sending} label={m.sendReset} /></Button>
		</form>
	{/if}
	<div class={formStatus} aria-live="polite">
		{#if status === 'saved'}<StateBadge tone="success">{m.saved}</StateBadge>{:else if status === 'sent'}<Alert.Message appearance="inline">{m.resetSent}</Alert.Message>{:else if status === 'invalid'}<Alert.Message appearance="inline" variant="destructive">{m.invalidCallback}</Alert.Message>{:else if status === 'failed'}<Alert.Message appearance="inline" variant="destructive">{m.authFailed}</Alert.Message>{:else if status === 'mismatch'}<Alert.Message appearance="inline" variant="destructive">{m.passwordMismatch}</Alert.Message>{:else if !admin.client}<Alert.Message appearance="inline" variant="destructive">{m.accessUnavailable}</Alert.Message>{/if}
	</div>
	{#if !verifiedToken && status !== 'saved'}<Button variant="link" class="justify-self-start" href={i18n.href('/admin/login')}>{m.backToSignIn}</Button>{/if}
</AdminAuthCard>
