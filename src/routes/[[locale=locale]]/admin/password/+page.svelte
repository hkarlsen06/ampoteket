<script lang="ts">
	import { formLayout, formStatus, pageHeader, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field';
	import { onMount } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext, adminReturnPath } from '$lib/admin-context.svelte';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let email = $state(''); let password = $state(''); let repeat = $state(''); let busy = $state(false);
	let status = $state<'idle' | 'sent' | 'failed' | 'invalid' | 'saved' | 'mismatch'>('idle');
	let callback = $state<{ code?: string; token_hash?: string; type?: 'invite' | 'recovery' } | null>(null);
	let verified = $state(false); let next = $state('/admin');
	onMount(() => {
		const url = new URL(window.location.href); next = adminReturnPath(url.searchParams.get('next'));
		const code = url.searchParams.get('code'); const token = url.searchParams.get('token_hash'); const type = url.searchParams.get('type');
		const invalid = Boolean(url.hash || url.searchParams.has('error') || (code && token)
			|| url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('token_hash').length > 1 || url.searchParams.getAll('type').length > 1);
		// Discard callback credentials before any in-page link can copy them.
		history.replaceState(history.state, '', i18n.href('/admin/password'));
		if (invalid) status = 'invalid';
		else if (code && /^[A-Za-z0-9_-]{10,2048}$/.test(code)) callback = { code };
		else if (token && /^(?:pkce_)?[a-f0-9]{32,256}$/.test(token) && (type === 'invite' || type === 'recovery')) callback = { token_hash: token, type };
		else if (code || token || type) status = 'invalid';
	});
	// Links are single-use; wait for a click so mail scanners that open them do not consume them.
	async function exchange() {
		if (!callback || !admin.auth || busy) return; busy = true;
		try {
			if (!admin.callbackOrigin || window.location.origin !== admin.callbackOrigin) throw new Error();
			const result = callback.code ? await admin.auth.exchangeCodeForSession(callback.code)
				: await admin.auth.verifyOtp({ token_hash: callback.token_hash!, type: callback.type! });
			callback = null; if (result.error || !result.data.session) throw new Error();
			verified = true; await admin.refresh();
		} catch { callback = null; status = 'invalid'; } finally { busy = false; }
	}
	async function send(event: SubmitEvent) {
		event.preventDefault(); if (!admin.auth || !admin.callbackOrigin || busy) return; busy = true; status = 'idle';
		try {
			const redirectTo = new URL(i18n.href('/admin/password'), admin.callbackOrigin); redirectTo.searchParams.set('next', next);
			const result = await admin.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo.href });
			if (result.error) throw result.error; status = 'sent';
		} catch { status = 'failed'; } finally { busy = false; }
	}
	async function save(event: SubmitEvent) {
		event.preventDefault(); if (!admin.auth || busy || !verified) return;
		if (password !== repeat) { status = 'mismatch'; return; } busy = true; status = 'idle';
		try { const result = await admin.auth.updateUser({ password }); if (result.error) throw result.error; password = ''; repeat = ''; status = 'saved'; }
		catch { status = 'failed'; } finally { busy = false; }
	}
</script>
<svelte:head><title>{m.passwordTitle}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{m.passwordHeading}</h1></header>
{#if status === 'saved'}
	<div class={formLayout}><Alert.Message appearance="inline" role="status">{m.passwordSaved}</Alert.Message><Button variant="default" href={i18n.href(next)}>{m.continue}</Button></div>
{:else if callback}
	<div class={formLayout}><Button variant="default" onclick={exchange} disabled={busy || !admin.auth}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.continue} /></Button></div>
{:else if verified}
	<form class={[formLayout, "max-w-md"]} onsubmit={save}>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.newPassword}</Field.Label><Input id={`${fieldId}-1`} type="password" autocomplete="new-password" minlength={8} required bind:value={password} disabled={busy} /></Field.Field>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-2`}>{m.repeatPassword}</Field.Label><Input id={`${fieldId}-2`} type="password" autocomplete="new-password" enterkeyhint="go" minlength={8} required bind:value={repeat} disabled={busy} /></Field.Field>
		<Button type="submit" variant="default" disabled={busy}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.savePassword} /></Button>
	</form>
{:else}
	<form class={[formLayout, "max-w-md"]} onsubmit={send}>
		<Field.Field width="grow"><Field.Label for={`${fieldId}-3`}>{m.email}</Field.Label><Input id={`${fieldId}-3`} type="email" autocomplete="username" enterkeyhint="send" required bind:value={email} disabled={busy} /></Field.Field>
		<Button type="submit" variant="default" disabled={busy || !admin.auth || !admin.callbackOrigin}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.sendReset} /></Button>
	</form>
{/if}
<div class={formStatus} aria-live="polite">
	{#if status === 'sent'}<Alert.Message appearance="inline" variant="default" role="status">{m.resetSent}</Alert.Message>{:else if status === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalidCallback}</Alert.Message>{:else if status === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.authFailed}</Alert.Message>{:else if status === 'mismatch'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.passwordMismatch}</Alert.Message>{:else if !admin.callbackOrigin || admin.status === 'unavailable'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}
</div>
<Button variant="link" href={i18n.href('/admin/login')}>{m.backToSignIn}</Button>
