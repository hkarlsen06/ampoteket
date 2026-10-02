<script lang="ts">
	import NewSpecificationDialog from '#lib/NewSpecificationDialog.svelte';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formGrid, formStatus, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { onMount, tick } from 'svelte';
	import { getI18n, specificationLabel } from '#lib/i18n/index.js';
	import { standardSpecificationDefinitions, productSpecificationFields } from '#lib/product-specifications.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readDraft, writeDraft } from '#lib/drafts.js';
	import { engineeringUnits, formatMeasurement, measurementInput, parseMeasurement } from '#lib/format.js';
	import { definitiveProductFailure, detailCommandKey, executeDetailCommand, parseAttribute, parseDetailCommand, readProductAttributes, StaleProductError, type AttributeDefinition, type AttributeValue, type DetailCommand, type ProductFamily, type ProductAttributeDraft } from '#lib/admin-products.js';
	// Every field is edited in place and written by the product's Save button:
	// prepare() validates (and stages values for a new product) before the
	// product write; commit() then saves each changed value of a saved product
	// as its own persisted, individually acknowledged command.
	let { productId, definitions = $bindable(), family, staged = $bindable([]), disabled = false, drafts = false }: { productId: string | null; definitions: AttributeDefinition[]; family: ProductFamily | null; staged?: ProductAttributeDraft[]; disabled?: boolean; drafts?: boolean } = $props();
	const draftProductId = '00000000-0000-4000-8000-000000000000';
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts); const uid = $props.id();
	let savedValues = $state.raw<AttributeValue[] | null>(null);
	let pending = $state.raw<DetailCommand | null>(null);
	// Only edited fields have an entry; the others show their saved or staged value.
	let edits = $state<Record<string, string>>({});
	let errors = $state<Record<string, 'invalid' | 'stale' | 'rejected'>>({});
	let added = $state<string[]>([]);
	let loading = $state(false); let loadFailed = $state(false); let outcome = $state<'idle' | 'unknown' | 'storage'>('idle'); let storageReady = $state(false); let alive = true;
	const storageKey = $derived(`${detailCommandKey}:attribute:${productId}`);
	const values = $derived(productId ? savedValues : staged.map(value => ({ ...value, product_id: draftProductId })));
	const definitionState = $derived.by(() => {
		try { return { definitions: standardSpecificationDefinitions(definitions), conflict: false }; }
		catch { return { definitions, conflict: true }; }
	});
	const pendingId = $derived(pending ? subject(pending).attribute_id : null);
	const layout = $derived(productSpecificationFields(family, definitionState.definitions, [...(values ?? []).map(value => value.attribute_id), ...added, ...(pendingId ? [pendingId] : [])]));
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	function subject(command: DetailCommand) { return (command.after ?? command.before) as AttributeValue; }
	onMount(() => {
		try {
			const raw = productId ? sessionStorage.getItem(storageKey) : null;
			if (raw) {
				const command = parseDetailCommand(JSON.parse(raw));
				if (command.kind !== 'attribute' || subject(command).product_id !== productId) throw new Error('Invalid saved attribute');
				pending = command;
			}
			const probe = storageKey + ':probe';
			sessionStorage.setItem(probe, '1');
			if (sessionStorage.getItem(probe) !== '1') throw new Error('Attribute storage unavailable');
			sessionStorage.removeItem(probe);
			storageReady = true;
		} catch { storageReady = false; }
		if (!productId) restoreDraft();
		void load();
		return () => { alive = false; };
	});
	async function load() {
		if (loading || !productId || admin.status !== 'ready') return;
		loading = true; loadFailed = false;
		const session = admin.credentials();
		try {
			const rows = await readProductAttributes(session, productId);
			if (alive && session.userId === admin.session?.user.id) { savedValues = rows; if (!draftRestored) restoreDraft(); }
		} catch (error) {
			if (alive) loadFailed = true;
			await admin.permissionFailure(error);
		} finally { if (alive) loading = false; }
	}
	// With `drafts`, unsaved values outlive a reload or sign-in round trip
	// (drafts.ts); command recovery leaves it off. A saved product's edits return
	// only while its stored values are unchanged, with any stale warning still owed,
	// so a restored edit never replaces someone else's newer value unseen.
	const draftName = $derived(`product:${productId ?? 'new'}:specifications`);
	const valuesKey = $derived(JSON.stringify([...(savedValues ?? [])].sort((a, b) => a.attribute_id.localeCompare(b.attribute_id))));
	let draftRestored = $state(false);
	function restoreDraft() {
		draftRestored = true;
		if (!drafts) return;
		const saved = readDraft(admin.session?.user.id, draftName) as { values?: unknown; edits?: unknown; added?: unknown; stale?: unknown } | null;
		const texts = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
		if (saved && (!productId || saved.values === valuesKey) && saved.edits && typeof saved.edits === 'object'
			&& texts(Object.values(saved.edits)) && texts(saved.added) && texts(saved.stale)) {
			edits = saved.edits as Record<string, string>; added = saved.added as string[];
			errors = Object.fromEntries((saved.stale as string[]).map(id => [id, 'stale' as const]));
		}
	}
	$effect(() => {
		if (!drafts || !draftRestored) return;
		const dirty = Object.entries(edits).some(([id, text]) => {
			const definition = definitions.find(item => item.id === id);
			return !definition || text !== asText(saved(id), unitOf(definition));
		});
		writeDraft(admin.session?.user.id, draftName, dirty ? { values: valuesKey, edits: $state.snapshot(edits), added: $state.snapshot(added), stale: Object.keys(errors).filter(id => errors[id] === 'stale') } : null);
	});
	function asText(value: Omit<AttributeValue, 'product_id'> | null | undefined, unit: string | null): string {
		return !value ? '' : value.number_value !== null ? measurementInput(value.number_value, unit, i18n.locale) : value.text_value ?? (value.boolean_value === null ? '' : String(value.boolean_value));
	}
	function saved(id: string) { return values?.find(value => value.attribute_id === id) ?? null; }
	function current(definition: AttributeDefinition): string {
		const id = definition.id; const unit = unitOf(definition);
		return pending && id === pendingId ? asText(pending.after as AttributeValue | null, unit) : id in edits ? edits[id] : asText(saved(id), unit);
	}
	function display(value: AttributeValue | null, unit: string | null): string {
		return !value ? '–' : value.number_value !== null ? formatMeasurement(value.number_value, unit, i18n.locale)
			: value.text_value !== null ? value.text_value : value.boolean_value ? m.yes : m.no;
	}
	function unitOf(definition: AttributeDefinition) { return definition.value_type === 'number' ? definition.canonical_unit : null; }
	/** Validates every edited field; null after marking the invalid ones. */
	function changes(): { before: AttributeValue | null; after: AttributeValue | null }[] | null {
		const writes: { before: AttributeValue | null; after: AttributeValue | null }[] = []; const invalid: typeof errors = {};
		for (const definition of layout.fields) {
			const input = edits[definition.id]; const before = saved(definition.id);
			if (input === undefined || definition.id === pendingId || input === asText(before, unitOf(definition))) continue;
			try {
				// A cleared field removes the value; unknown stays missing, never zero or no.
				const after = !input.trim() ? null : parseAttribute({
					product_id: productId ?? draftProductId, attribute_id: definition.id,
					number_value: definition.value_type === 'number' ? parseMeasurement(input, definition.canonical_unit, i18n.locale) : null,
					text_value: definition.value_type === 'text' ? input : null,
					boolean_value: definition.value_type === 'boolean' ? input === 'true' : null
				});
				if (before || after) writes.push({ before, after });
			} catch { invalid[definition.id] = 'invalid'; }
		}
		errors = invalid;
		const first = Object.keys(invalid)[0];
		if (!first) return writes;
		void tick().then(() => document.getElementById(`${uid}-${first}`)?.focus());
		return null;
	}
	// A value read from the product name fills its field while that field is empty
	// or still holds the previous suggestion; typed values are never replaced.
	const suggested: Record<string, string> = {};
	export function suggest(code: string, value: string) {
		const definition = layout.fields.find(field => field.code === code);
		if (!definition || disabled || definitionState.conflict || definition.id === pendingId) return;
		const shown = current(definition);
		if (shown && shown !== suggested[definition.id]) return;
		edits[definition.id] = suggested[definition.id] = measurementInput(value, unitOf(definition), i18n.locale);
	}
	// Leaving a number field shows how it was read ("27p" → "27 pF"). Errors change only on
	// save, as in the rest of the form: adding or removing a message here would move Save
	// between pointer-down and pointer-up, and the click would be lost.
	function tidy(definition: AttributeDefinition) {
		const input = edits[definition.id]; const unit = unitOf(definition);
		if (definition.value_type !== 'number' || !input?.trim()) return;
		try { edits[definition.id] = measurementInput(parseMeasurement(input, unit, i18n.locale), unit, i18n.locale); }
		catch { /* Kept as typed; save reports and focuses it. */ }
	}
	export function prepare(): boolean {
		const writes = changes();
		if (!writes) return false;
		if (!productId) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map; only its values reach state.
			const rows = new Map(staged.map(value => [value.attribute_id, value]));
			for (const { before, after } of writes) {
				rows.delete((after ?? before)!.attribute_id);
				if (after) { const { product_id, ...row } = after; rows.set(row.attribute_id, row); }
			}
			staged = [...rows.values()]; edits = {};
		}
		return true;
	}
	export async function commit(): Promise<boolean> {
		if (!productId) return true;
		const writes = changes();
		if (!writes) return false;
		if (!pending && !writes.length) return true;
		if (wrongIdentity || admin.status !== 'ready' || !savedValues) return false;
		if (!storageReady) { outcome = 'storage'; return false; }
		const session = admin.credentials(); outcome = 'idle';
		const queue: (DetailCommand | null)[] = [...(pending ? [null] : []), ...writes.map(({ before, after }) => ({ userId: session.userId, kind: 'attribute' as const, before, after }))];
		for (const next of queue) {
			try {
				if (next) {
					const raw = JSON.stringify(next);
					if (sessionStorage.getItem(storageKey)) throw new Error('Unresolved attribute');
					sessionStorage.setItem(storageKey, raw);
					if (sessionStorage.getItem(storageKey) !== raw) throw new Error('Attribute storage unavailable');
					pending = parseDetailCommand(next);
				}
				const command = pending!;
				if (JSON.stringify(parseDetailCommand(JSON.parse(sessionStorage.getItem(storageKey) ?? ''))) !== JSON.stringify(command)) throw new Error('Attribute command changed');
				await executeDetailCommand(session, command);
				sessionStorage.removeItem(storageKey);
				if (!alive || session.userId !== admin.session?.user.id) return false;
				const id = subject(command).attribute_id;
				pending = null;
				savedValues = [...(savedValues ?? []).filter(value => value.attribute_id !== id), ...(command.after ? [command.after as AttributeValue] : [])];
				delete edits[id];
			} catch (error) {
				const id = pending ? subject(pending).attribute_id : null;
				if (pending && (error instanceof StaleProductError || definitiveProductFailure(error))) {
					sessionStorage.removeItem(storageKey);
					pending = null;
					// The draft stays in its field; the refreshed value becomes the next save's guard.
					errors[id!] = error instanceof StaleProductError ? 'stale' : 'rejected';
					if (error instanceof StaleProductError) void load();
				} else outcome = pending ? 'unknown' : 'storage';
				await admin.permissionFailure(error);
				return false;
			}
		}
		return true;
	}
	async function add(event: Event & { currentTarget: HTMLSelectElement }) {
		const id = event.currentTarget.value; event.currentTarget.value = '';
		if (!id) return;
		added = [...added, id];
		await tick(); document.getElementById(`${uid}-${id}`)?.focus();
	}
</script>
<section class={section({ spacing: 'divided', class: 'specifications' })} aria-labelledby="specifications-title">
	<Separator />
	<h2 class={sectionHeading} id="specifications-title">{m.attributes}</h2>
	{#if definitionState.conflict}<Alert.Message appearance="inline" variant="destructive" role="status">{m.specificationConflict}</Alert.Message>{/if}
	{#if values === null}
		<div class="grid min-h-24 content-start justify-items-start gap-2" aria-busy={!loadFailed}>
			{#if loadFailed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button variant="outline" onclick={load}>{m.retry}</Button>
			{:else}<Skeleton class="h-12 w-full max-w-68 justify-self-stretch" aria-hidden="true" /><span class="sr-only" role="status">{m.loading}</span>{/if}
		</div>
	{:else}
		<div class={formGrid}>
			{#each layout.fields as definition (definition.id)}
				{@const id = `${uid}-${definition.id}`}
				{@const unit = unitOf(definition)}
				{@const locked = disabled || definitionState.conflict || definition.id === pendingId}
				{@const error = errors[definition.id]}
				{@const describedBy = [error && `${id}-error`, definition.value_type === 'number' && `${uid}-hint`].filter(Boolean).join(' ') || undefined}
				<Field.Field data-invalid={Boolean(error)}>
					<Field.Label for={id}>{specificationLabel(definition.code, definition, i18n.locale)}{#if unit} <span class="sr-only">({unit})</span>{/if}</Field.Label>
					{#if definition.value_type === 'boolean'}
						<NativeSelect.Root {id} bind:value={() => current(definition), (next) => edits[definition.id] = next} disabled={locked} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
							<NativeSelect.Option value="">{m.unset}</NativeSelect.Option>
							<NativeSelect.Option value="true">{m.yes}</NativeSelect.Option>
							<NativeSelect.Option value="false">{m.no}</NativeSelect.Option>
						</NativeSelect.Root>
					{:else if unit}
						<InputGroup.Root><InputGroup.Input {id} type="text" inputmode={engineeringUnits(unit).length > 1 ? 'text' : 'decimal'} maxlength={2000} bind:value={() => current(definition), (next) => edits[definition.id] = next} onchange={() => tidy(definition)} disabled={locked} aria-invalid={Boolean(error)} aria-describedby={describedBy} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unit}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>
					{:else}
						<Input {id} type="text" inputmode={definition.value_type === 'number' ? 'decimal' : 'text'} maxlength={2000} bind:value={() => current(definition), (next) => edits[definition.id] = next} onchange={() => tidy(definition)} disabled={locked} aria-invalid={Boolean(error)} aria-describedby={describedBy} />
					{/if}
					{#if error}<Field.Error id={`${id}-error`}>{error === 'stale' ? m.attributeChanged(display(saved(definition.id), unit)) : error === 'rejected' ? m.failed : m.attributeInvalid}</Field.Error>{/if}
				</Field.Field>
			{/each}
		</div>
		{#if layout.fields.some(definition => definition.value_type === 'number')}<Field.Description id={`${uid}-hint`}>{m.attributesHint}</Field.Description>{/if}
		<div class={formGrid}>
			{#if layout.addable.length}
				<Field.Field class="col-span-2 md:col-span-1">
					<Field.Label for={`${uid}-add`}>{m.addAttribute}</Field.Label>
					<NativeSelect.Root id={`${uid}-add`} value="" onchange={add} disabled={disabled || definitionState.conflict}>
						<NativeSelect.Option value="">{m.chooseAttribute}</NativeSelect.Option>
						{#each layout.addable as definition (definition.id)}<NativeSelect.Option value={definition.id}>{specificationLabel(definition.code, definition, i18n.locale)}{definition.canonical_unit ? ` (${definition.canonical_unit})` : ''}</NativeSelect.Option>{/each}
					</NativeSelect.Root>
				</Field.Field>
			{/if}
			<NewSpecificationDialog class="col-span-2 md:col-span-1" {disabled} oncreated={(definition) => { definitions = [...definitions.filter(item => item.id !== definition.id), definition]; added = [...added, definition.id]; }} />
		</div>
	{/if}
	<div class={formStatus} aria-live="polite">
		{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
		{:else if productId && !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storage}</Alert.Message>
		{:else if pending || outcome !== 'idle'}<Alert.Message appearance="inline" variant="destructive" role="status">{outcome === 'storage' ? m.storage : m.unknown}</Alert.Message>
		{:else if loadFailed && values}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button variant="outline" onclick={load}>{m.retry}</Button>{/if}
	</div>
</section>
