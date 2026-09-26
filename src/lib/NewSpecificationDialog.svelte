<script lang="ts">
	import { onMount } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Alert from '$lib/components/ui/alert';
	import { Input } from '$lib/components/ui/input';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { formLayout, formStatus, sheetBody } from '$lib/ui';
	import AdminAccessGate from '$lib/AdminAccessGate.svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { definitiveProductFailure, detailCommandKey, executeDetailCommand, parseDefinition, parseDetailCommand, StaleProductError, type AttributeDefinition, type DetailCommand } from '$lib/admin-products';

	let { disabled = false, class: className, oncreated }: { disabled?: boolean; class?: string; oncreated: (definition: AttributeDefinition) => void } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts); const uid = $props.id();
	const storageKey = `${detailCommandKey}:new-definition`;
	let open = $state(false); let label = $state(''); let type = $state<AttributeDefinition['value_type']>('number'); let unit = $state('');
	let pending = $state<DetailCommand | null>(null); let busy = $state(false); let storageReady = $state(false); let outcome = $state('idle'); let alive = true;
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	onMount(() => {
		try {
			const raw = sessionStorage.getItem(storageKey);
			if (raw) {
				const command = parseDetailCommand(JSON.parse(raw));
				if (command.kind !== 'definition' || command.before || !command.after) throw new Error('Invalid new specification');
				pending = command;
				const definition = command.after as AttributeDefinition;
				label = definition.label; type = definition.value_type; unit = definition.canonical_unit ?? '';
			}
			const probe = `${storageKey}:probe`;
			sessionStorage.setItem(probe, '1');
			if (sessionStorage.getItem(probe) !== '1') throw new Error('Specification storage unavailable');
			sessionStorage.removeItem(probe);
			storageReady = true;
		} catch { storageReady = false; }
		return () => { alive = false; };
	});
	function storedCommand() {
		if (!pending || JSON.stringify(parseDetailCommand(JSON.parse(sessionStorage.getItem(storageKey) ?? ''))) !== JSON.stringify(pending)) throw new Error('Specification command changed');
	}
	function clearPending() {
		storedCommand();
		sessionStorage.removeItem(storageKey);
		if (sessionStorage.getItem(storageKey) !== null) throw new Error('Specification command not cleared');
		pending = null;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (disabled || busy || !storageReady || wrongIdentity || admin.status !== 'ready') return;
		const session = admin.credentials(); busy = true; outcome = 'idle';
		try {
			if (!pending) {
				let definition: AttributeDefinition;
				try {
					const id = crypto.randomUUID();
					definition = parseDefinition({ id, code: `custom_${id.replaceAll('-', '_')}`, label: label.trim(), value_type: type, canonical_unit: type === 'number' ? unit.trim() || null : null });
				} catch { outcome = 'invalid'; return; }
				const command: DetailCommand = { userId: session.userId, kind: 'definition', before: null, after: definition };
				const raw = JSON.stringify(command);
				if (sessionStorage.getItem(storageKey)) throw new Error('Unresolved specification');
				sessionStorage.setItem(storageKey, raw);
				if (sessionStorage.getItem(storageKey) !== raw) throw new Error('Specification storage unavailable');
				pending = command;
			}
			storedCommand();
			const definition = pending.after as AttributeDefinition;
			await executeDetailCommand(session, pending);
			clearPending();
			if (!alive || session.userId !== admin.session?.user.id) return;
			oncreated(definition); open = false; label = ''; type = 'number'; unit = ''; outcome = 'idle';
		} catch (error) {
			if (pending && (error instanceof StaleProductError || definitiveProductFailure(error))) {
				try { clearPending(); outcome = 'invalid'; } catch { outcome = 'unknown'; }
			} else outcome = pending ? 'unknown' : 'storage';
			await admin.permissionFailure(error);
		} finally { if (alive) busy = false; }
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>
		{#snippet child({ props })}<Button {...props} type="button" variant="outline" class={className} {disabled}>{pending ? m.referenceRecovery : m.newDefinition}</Button>{/snippet}
	</Dialog.Trigger>
	<Dialog.Content preventScroll={false} aria-describedby={undefined} class="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
		<Dialog.Header layout="bar">
			<Dialog.Title id={`${uid}-title`}>{m.newDefinition}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{m.cancel}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll region supports native keyboard scrolling.) -->
		<div class={sheetBody} role="region" aria-labelledby={`${uid}-title`} tabindex="0">
		<AdminAccessGate>
		<form id={`${uid}-form`} class={formLayout} onsubmit={save}>
			<Field.Field><Field.Label for={`${uid}-label`}>{m.definitionLabel}</Field.Label><Input id={`${uid}-label`} bind:value={label} required maxlength={100} disabled={busy || Boolean(pending) || wrongIdentity} /></Field.Field>
			<Field.Set class="gap-2">
				<Field.Legend id={`${uid}-type`} variant="label">{m.valueType}</Field.Legend>
				<ToggleGroup.Root type="single" variant="outline" value={type} onValueChange={(value) => { if (value) type = value as AttributeDefinition['value_type']; }} aria-labelledby={`${uid}-type`} disabled={busy || Boolean(pending) || wrongIdentity}>
					<ToggleGroup.Item value="number">{m.numberType}</ToggleGroup.Item>
					<ToggleGroup.Item value="text">{m.textType}</ToggleGroup.Item>
					<ToggleGroup.Item value="boolean">{m.booleanType}</ToggleGroup.Item>
				</ToggleGroup.Root>
			</Field.Set>
			{#if type === 'number'}<Field.Field><Field.Label for={`${uid}-unit`}>{m.canonicalUnit}</Field.Label><Input id={`${uid}-unit`} bind:value={unit} maxlength={100} disabled={busy || Boolean(pending) || wrongIdentity} /></Field.Field>{/if}
		</form>
		<div class={formStatus} aria-live="polite">
			{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
			{:else if !storageReady || outcome === 'storage'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storage}</Alert.Message>
			{:else if !busy && (outcome !== 'idle' || pending)}<Alert.Message appearance="inline" variant="destructive" role="status">{outcome === 'invalid' ? m.referenceInvalid : m.unknown}</Alert.Message>{/if}
		</div>
		</AdminAccessGate>
		</div>
		<Dialog.Footer variant="sheet">
			<Button type="submit" form={`${uid}-form`} disabled={disabled || busy || !storageReady || wrongIdentity || admin.status !== 'ready'}><ButtonLabel pending={busy} pendingLabel={m.working} label={pending ? m.retrySave : m.saveReference} reserveLabels={[m.retrySave, m.saveReference]} /></Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
