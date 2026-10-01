<script lang="ts">
	import { formStatus, lede, pageHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
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
<!-- The drawer wall on a night panel beside the form (a band above it on phones),
     with the sign's lit red dot and the square mark. Decorative: the form stands alone. -->
<Card.Root class="mx-auto max-w-4xl gap-0 py-0 md:grid md:grid-cols-[5fr_6fr]">
	<div class="scheme-night relative min-h-36 rounded-t-xl bg-night md:rounded-l-xl md:rounded-tr-none" aria-hidden="true">
		<img class="absolute inset-0 size-full rounded-[inherit] object-cover object-[50%_35%] mask-b-from-30% md:mask-b-from-55%"
			srcset="/photos/drawers-960.webp 960w, /photos/drawers-1280.webp 1280w" sizes="(min-width: 48rem) 25rem, 100vw"
			src="/photos/drawers-960.webp" width="3418" height="2757" alt="" decoding="async" />
		<div class="absolute inset-x-0 bottom-0 flex items-center gap-3 p-5 md:p-8">
			<img src="/brand/mark-square-64.png" alt="" width="40" height="40" class="size-10 rounded-md" />
			<span class="inline-flex items-center gap-2.5 text-sm text-night-muted"><span class="size-1.5 rounded-full bg-night-accent shadow-[0_0_0.5rem_var(--night-accent)]"></span>{m.heading}</span>
		</div>
	</div>
	<div class="grid content-start gap-6 p-5 md:p-10">
		<header class="grid gap-2">
			<h1 class={pageHeading}>{m.signIn}</h1>
			{#if admin.status !== 'ready' && admin.status !== 'noAccess' && admin.status !== 'revoked'}<p class={lede}>{m.signInRequired}</p>{/if}
		</header>
		{#if admin.status === 'noAccess' || admin.status === 'revoked'}
			<Alert.Message appearance="inline" role="status">{admin.status === 'revoked' ? m.revoked : m.noAccess}</Alert.Message>
			<Button type="button" variant="outline" class="justify-self-start" onclick={() => admin.signOut()}>{m.signOut}</Button>
		{:else if admin.status === 'ready'}
			<p>{m.signedInAs(admin.membership?.displayName ?? '')}</p>
			<Button variant="default" class="w-full" href={i18n.href(next)}>{m.continue}</Button>
		{:else}
			<form class="grid gap-5" onsubmit={signIn}>
				<Field.Field><Field.Label for={`${fieldId}-1`}>{m.email}</Field.Label><Input id={`${fieldId}-1`} type="email" autocomplete="username" required bind:value={email} disabled={busy} /></Field.Field>
				<Field.Field><Field.Label for={`${fieldId}-2`}>{m.password}</Field.Label><Input id={`${fieldId}-2`} type="password" autocomplete="current-password" enterkeyhint="go" required bind:value={password} disabled={busy} /></Field.Field>
				<Button type="submit" variant="default" class="w-full" disabled={busy || !admin.auth}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.signIn} /></Button>
				<Button variant="link" class="justify-self-start" href={i18n.href(`/admin/password?next=${encodeURIComponent(next)}`)}>{m.forgotPassword}</Button>
			</form>
			<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.signInFailed}</Alert.Message>{:else if admin.status === 'unavailable'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
		{/if}
	</div>
</Card.Root>
