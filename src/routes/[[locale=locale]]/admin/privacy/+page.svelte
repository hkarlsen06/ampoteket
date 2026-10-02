<script lang="ts">
	import { productName } from '#lib/catalog.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { codeText, formLayout, formStatus, itemTitle, lede, nameWrap, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { onMount } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { clearRecoveryCommand, readRecoveryCommand, saveRecoveryCommand, readStaffCheckout, recoverStaffCheckout, staffRequest, type StaffCheckout, type RecoveryCommand } from '#lib/admin-api.js';
	import { object, uuidPattern } from '#lib/api.js';
	import { formatCountedAt, formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.admin);
	let reference = $state(''); let snapshot = $state<StaffCheckout | null>(null); let busy = $state(false);
	let outcome = $state<'idle' | 'missing' | 'failed' | 'invalid' | 'registered' | 'unknown'>('idle');
	let reason = $state(''); let identified = $state(false); let command = $state<RecoveryCommand | null>(null);
	let storageReady = $state(false); let wrongIdentity = $state(false);
	let contact = $state<string | null>(null); let contactShown = $state(false); let clearOpen = $state(false);
	onMount(() => {
		try {
			const pending = readRecoveryCommand(sessionStorage);
			// Test storage before enabling any stock-changing action.
			const key = 'ampoteket:admin-storage-test'; sessionStorage.setItem(key, '1');
			if (sessionStorage.getItem(key) !== '1') throw new Error(); sessionStorage.removeItem(key); storageReady = true;
			if (pending) {
				command = pending; wrongIdentity = pending.userId !== admin.session?.user.id;
				if (!wrongIdentity) { reference = pending.checkoutId; reason = pending.reason; identified = true; void lookup(); }
			}
		} catch { storageReady = false; }
	});
	async function lookup(event?: SubmitEvent) {
		event?.preventDefault(); if (busy || wrongIdentity) return;
		const ref = reference.trim().toLowerCase();
		if (!uuidPattern.test(ref)) { outcome = 'invalid'; return; }
		busy = true; outcome = 'idle'; snapshot = null; contact = null; contactShown = false;
		if (!command) { reason = ''; identified = false; }
		try {
			const session = admin.credentials();
			const result = await readStaffCheckout(session, ref);
			if (admin.session?.user.id !== session.userId) return;
			snapshot = result; if (!snapshot) outcome = 'missing';
			if (snapshot?.registered && command && command.checkoutId === snapshot.id) {
				clearRecoveryCommand(sessionStorage, command); command = null; outcome = 'registered';
			}
		} catch (error) { outcome = 'failed'; await admin.permissionFailure(error); } finally { busy = false; }
	}
	async function recover(event: SubmitEvent) {
		event.preventDefault(); if (admin.status !== 'ready' || !snapshot || busy || !identified || !storageReady || wrongIdentity) return;
		busy = true; outcome = 'idle';
		try {
			const session = admin.credentials();
			if (!command) command = saveRecoveryCommand(sessionStorage, { userId: session.userId, requestId: crypto.randomUUID(), checkoutId: snapshot.id, reason: reason.trim() });
			// Always read the durable command again; never reconstruct an uncertain retry.
			const saved = readRecoveryCommand(sessionStorage);
			if (!saved || saved.checkoutId !== snapshot.id || saved.requestId !== command.requestId || saved.userId !== session.userId) throw new Error();
			await recoverStaffCheckout(session, saved);
			if (admin.session?.user.id !== session.userId) return;
			const result = await readStaffCheckout(session, snapshot.id);
			if (!result?.registered || admin.session?.user.id !== session.userId) throw new Error();
			snapshot = result; clearRecoveryCommand(sessionStorage, saved); command = null; outcome = 'registered';
		} catch (error) { outcome = command ? 'unknown' : 'failed'; await admin.permissionFailure(error); } finally { busy = false; }
	}
	async function loadContact() {
		if (admin.status !== 'ready' || !snapshot || busy) return; busy = true; outcome = 'idle';
		try {
			const session = admin.credentials();
			const rows = await staffRequest(session, 'amp_checkout_contacts', { select: 'checkout_id,contact_text', checkout_id: `eq.${snapshot.id}`, limit: '2' });
			if (!Array.isArray(rows) || rows.length > 1) throw new Error();
			let value: string | null = null;
			if (rows.length) { const row = object(rows[0]); if (row.checkout_id !== snapshot.id || typeof row.contact_text !== 'string' || [...row.contact_text].length > 300) throw new Error(); value = row.contact_text; }
			if (admin.session?.user.id === session.userId) { contact = value; contactShown = true; }
		} catch (error) { outcome = 'failed'; await admin.permissionFailure(error); } finally { busy = false; }
	}
	async function clearContact() {
		if (admin.status !== 'ready' || !snapshot || busy) return; clearOpen = false; busy = true;
		try {
			const session = admin.credentials();
			const result = object(await staffRequest(session, 'rpc/amp_clear_checkout_contact', {}, { p_checkout_id: snapshot.id }));
			if (result.checkout_id !== snapshot.id || typeof result.contact_removed !== 'boolean') throw new Error();
			if (admin.session?.user.id === session.userId) contact = null;
		} catch (error) { outcome = 'failed'; await admin.permissionFailure(error); } finally { busy = false; }
	}
</script>
<svelte:head><title>{m.recoveryTitle}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{m.recoveryHeading}</h1><p class={lede}>{m.recoveryIntro}</p></header>
<form class={formLayout} onsubmit={lookup}>
	<Field.Group layout="row">
		<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.reference}</Field.Label><Input id={`${fieldId}-1`} class="font-mono" required autocomplete="off" spellcheck="false" bind:value={reference} disabled={busy || Boolean(command)} /></Field.Field>
		<Button type="submit" disabled={busy || wrongIdentity}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.lookup} /></Button>
	</Field.Group>
</form>
<div class={formStatus} aria-live="polite">
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.commandIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
	{:else if outcome === 'missing'}<Alert.Message appearance="inline" variant="default" role="status">{m.checkoutMissing}</Alert.Message>
	{:else if outcome === 'failed'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.operationFailed}</Alert.Message>
	{:else if outcome === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.invalidReference}</Alert.Message>
	{:else if outcome === 'registered'}<Alert.Message appearance="inline" variant="default" role="status">{m.registered}</Alert.Message>
	{:else if outcome === 'unknown'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.recoveryUnknown}</Alert.Message>{/if}
</div>
{#if snapshot}
	<section class={section({ spacing: 'divided', class: "pb-6" })} aria-labelledby="snapshot-title">
		<Separator />
		<h2 class={sectionHeading} id="snapshot-title">{m.savedCheckout}</h2>
		<dl class="grid gap-3 md:grid-cols-[repeat(3,minmax(0,auto))] md:justify-start md:gap-x-10 [&_dt]:text-sm [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:ml-0 [&_dd]:wrap-anywhere"><div><dt>{m.checkoutReference}</dt><dd class={codeText}>{snapshot.id}</dd></div><div><dt>{m.requestReference}</dt><dd class={codeText}>{snapshot.requestId}</dd></div><div><dt>{m.created}</dt><dd>{formatCountedAt(snapshot.createdAt, i18n.locale)}</dd></div></dl>
		<Item.Group>
			{#each snapshot.items as item, index (item.productId)}
				{#if index > 0}<Item.Separator />{/if}
				<Item.Root variant="row" role="listitem" class="md:grid md:grid-cols-[1fr_20rem]">
					<Item.Content class="min-w-0"><Item.Title class={[itemTitle, nameWrap]}>{productName(item, i18n.locale)}</Item.Title><Item.Description class={codeText}>{item.code}</Item.Description></Item.Content>
					<dl class="m-0 w-full [&>div]:flex [&>div]:justify-between [&>div]:gap-4 [&_dd]:m-0 [&_dd]:text-right">
						<div><dt>{m.quantity}</dt><dd>{i18n.m.shop.quantity(formatDecimal(item.quantity, i18n.locale), unitLabel(item.unit, i18n.locale, item.quantity))}</dd></div>
						<div><dt>{m.unitPrice}</dt><dd class="font-mono">{formatMoney(item.unitPrice, i18n.locale)}</dd></div>
					</dl>
				</Item.Root>
			{/each}
		</Item.Group>
		<Separator />
		<p class="flex max-w-none flex-wrap items-baseline justify-between gap-x-4 gap-y-2"><strong class="font-semibold">{m.total}</strong><strong class="font-mono text-xl font-semibold tabular-nums">{formatMoney(snapshot.total, i18n.locale)}</strong></p>
		<p>{snapshot.registered ? m.registered : m.unregistered}</p>
		{#if snapshot.registeredAt}<p>{m.registrationTime(formatCountedAt(snapshot.registeredAt, i18n.locale))}</p>{/if}
		<p>{m.paymentUnverified}</p>
	</section>
	{#if !snapshot.registered}
		<section class={section({ spacing: 'divided', class: "pb-6" })} aria-labelledby="recovery-title">
			<Separator />
			<h2 class={sectionHeading} id="recovery-title">{m.recoverAction}</h2><p>{m.identificationWarning}</p>
			<p>{m.countWarning}</p>
			<ol>{#each m.countSteps as step (step)}<li>{step}</li>{/each}</ol>
			<form class={formLayout} onsubmit={recover}>
				<Field.Field><Field.Label for="recovery-reason">{m.reason}</Field.Label><Textarea id="recovery-reason" required maxlength={2000} rows={3} aria-describedby="recovery-reason-hint" bind:value={reason} disabled={busy || Boolean(command)}></Textarea><Field.Description id="recovery-reason-hint">{m.reasonHint}</Field.Description></Field.Field>
				<Field.Field orientation="horizontal"><Checkbox id="checkbox-identified" name="checkbox-identified" required bind:checked={identified} disabled={busy || Boolean(command)} /><Field.Label for="checkbox-identified" class="cursor-pointer">{m.identified}</Field.Label></Field.Field>
				<Button type="submit" variant="default" disabled={busy || !identified || !reason.trim() || !storageReady || wrongIdentity}><ButtonLabel pending={busy} pendingLabel={m.working} label={command ? m.retryRecovery : m.recoverAction} reserveLabels={[m.retryRecovery, m.recoverAction]} /></Button>
			</form>
		</section>
	{/if}
	<section class={section({ spacing: 'divided', class: "pb-6" })} aria-labelledby="contact-title">
		<Separator />
		<h2 class={sectionHeading} id="contact-title">{m.buyerContact}</h2><p>{m.contactWarning}</p>
		{#if !contactShown}<Button type="button" variant="outline" disabled={busy} onclick={loadContact}>{m.showContact}</Button>
		{:else if contact}<p class="wrap-anywhere">{contact}</p>
			<AlertDialog.Root bind:open={clearOpen}>
				<AlertDialog.Trigger disabled={busy}>{#snippet child({ props })}<Button {...props} variant="outline">{m.clearContact}</Button>{/snippet}</AlertDialog.Trigger>
				<AlertDialog.Content preventScroll={false}>
					<AlertDialog.Header>
						<AlertDialog.Title>{m.clearContact}</AlertDialog.Title>
						<AlertDialog.Description aria-label={m.clearContact}>{m.confirmClear}</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{m.cancel}</AlertDialog.Cancel>
						<AlertDialog.Action disabled={admin.status !== 'ready' || busy} onclick={clearContact}>{m.clearContact}</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		{:else}<Empty.Root role="status"><Empty.Description>{m.noContact}</Empty.Description></Empty.Root>{/if}
	</section>
{/if}
