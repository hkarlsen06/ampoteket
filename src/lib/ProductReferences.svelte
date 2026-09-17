<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
	import { codeText, formStatus, section, sectionHeading } from '$lib/ui';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import * as Item from '$lib/components/ui/item';
	import * as Alert from '$lib/components/ui/alert';
	import { onMount } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { definitiveProductFailure, detailCommandKey, executeDetailCommand, parseDetailCommand, readProductReferences, StaleProductError, type AttributeDefinition, type Category, type DetailCommand, type ProductReferences } from '$lib/admin-products';

	let { onrefresh }: { onrefresh: (value: ProductReferences) => void } = $props();
	const i18n = getI18n();
	const admin = getAdminContext();
	const m = $derived(i18n.m.adminProducts);
	const key = detailCommandKey + ':references';
	let pending = $state<DetailCommand | null>(null);
	let storedCommand = '';
	let visible = $state(false);
	let storageReady = $state(false);
	let busy = $state(false);
	let outcome = $state('idle');
	let alive = true;
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	const category = $derived(pending?.kind === 'category' ? pending.after as Category : null);
	const definition = $derived(pending?.kind === 'definition' ? pending.after as AttributeDefinition : null);

	onMount(() => {
		// Only recover attempts saved before categories and specifications became predefined.
		try {
			const raw = sessionStorage.getItem(key);
			if (raw) {
				visible = true;
				const command = parseDetailCommand(JSON.parse(raw));
				if (command.kind === 'attribute') throw new Error('Unexpected reference command');
				pending = command;
				storedCommand = raw;
				const probe = key + ':probe';
				sessionStorage.setItem(probe, '1');
				if (sessionStorage.getItem(probe) !== '1') throw new Error('Reference storage unavailable');
				sessionStorage.removeItem(probe);
				storageReady = true;
			}
		} catch {
			visible = true;
			storageReady = false;
		}
		return () => { alive = false; };
	});

	function clearPending() {
		if (sessionStorage.getItem(key) !== storedCommand) throw new Error('Reference command changed');
		sessionStorage.removeItem(key);
		if (sessionStorage.getItem(key) !== null) throw new Error('Reference command was not cleared');
		pending = null;
	}

	async function retry() {
		if (busy || !pending || !storageReady || wrongIdentity) return;
		busy = true;
		outcome = 'idle';
		try {
			const session = admin.credentials();
			if (sessionStorage.getItem(key) !== storedCommand) throw new Error('Reference command changed');
			await executeDetailCommand(session, pending);
			clearPending();
			if (!alive || session.userId !== admin.session?.user.id) return;
			outcome = 'saved';
			try {
				const references = await readProductReferences(session);
				if (alive && session.userId === admin.session?.user.id) onrefresh(references);
			} catch (error) {
				outcome = 'savedRefreshFailed';
				await admin.permissionFailure(error);
			}
		} catch (error) {
			if (error instanceof StaleProductError || definitiveProductFailure(error)) {
				try {
					clearPending();
					outcome = error instanceof StaleProductError ? 'stale' : 'invalid';
				} catch { outcome = 'unknown'; }
			} else outcome = 'unknown';
			await admin.permissionFailure(error);
		} finally {
			if (alive) busy = false;
		}
	}
</script>

{#if visible}
	<section class={section({ spacing: 'divided' })} aria-labelledby="references-title">
		<Separator />
		<h2 class={sectionHeading} id="references-title">{m.referenceRecovery}</h2>
		{#if pending && !wrongIdentity}
			<dl class="my-4 [&_dt]:font-semibold [&_dd]:m-0 [&_dd]:wrap-break-word">
				{#if category}
					<Item.Root variant="row" class="grid gap-1 py-1"><dt>{m.categoryName}</dt><dd>{category.name}</dd></Item.Root>
				{:else if definition}
					<Item.Root variant="row" class="grid gap-1 py-1"><dt>{m.definitionLabel}</dt><dd>{definition.label}</dd></Item.Root>
					<Item.Root variant="row" class="grid gap-1 py-1"><dt>{m.definitionCode}</dt><dd class={codeText}>{definition.code}</dd></Item.Root>
					<Item.Root variant="row" class="grid gap-1 py-1"><dt>{m.valueType}</dt><dd>{definition.value_type === 'number' ? m.numberType : definition.value_type === 'text' ? m.textType : m.booleanType}</dd></Item.Root>
					{#if definition.canonical_unit}<Item.Root variant="row" class="grid gap-1 py-1"><dt>{m.canonicalUnit}</dt><dd>{definition.canonical_unit}</dd></Item.Root>{/if}
				{/if}
			</dl>
			<Button variant="outline" disabled={busy || !storageReady} onclick={retry}><ButtonLabel pending={busy} pendingLabel={m.working} label={m.retrySave} /></Button>
		{/if}
		<div class={formStatus} aria-live="polite">
			{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
			{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storage}</Alert.Message>
			{:else if outcome !== 'idle' || pending}<Alert.Message appearance="inline" role="status" variant={outcome !== 'saved' && outcome !== 'idle' ? 'destructive' : 'default'}>{outcome === 'saved' ? m.referenceSaved : outcome === 'savedRefreshFailed' ? m.savedRefreshFailed : outcome === 'stale' ? m.referenceRecoveryStale : outcome === 'invalid' ? m.referenceRecoveryRejected : m.unknown}</Alert.Message>{/if}
		</div>
	</section>
{/if}
