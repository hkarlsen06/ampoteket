<script lang="ts">
	import { onMount } from 'svelte';
	import ProductAttributes from '#lib/ProductAttributes.svelte';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { getI18n, specificationLabel } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { formatDecimal } from '#lib/format.js';
	import { standardSpecificationDefinitions } from '#lib/product-specifications.js';
	import { readProductSpecificationReview, replaceReviewedProductCommand, type AttributeDefinition, type AttributeValue, type ProductAttributeDraft, type ProductCommand, type ProductFamily, type ProductSpecificationReview } from '#lib/admin-products.js';
	import { formActions, formStatus, sectionHeading } from '#lib/ui.js';

	let { command, definitions = $bindable(), family, disabled = false, onreviewed }: { command: ProductCommand; definitions: AttributeDefinition[]; family: ProductFamily | null; disabled?: boolean; onreviewed: (command: ProductCommand) => void } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	let staged = $state<ProductAttributeDraft[]>([]);
	let review = $state<ProductSpecificationReview | null>(null);
	let busy = $state(false); let failed = $state(false); let alive = true;
	let storageFailed = $state(false);
	let editor: { prepare(): boolean } | undefined;
	const wrongIdentity = $derived(command.userId !== admin.session?.user.id);
	const labels = $derived.by(() => { try { return standardSpecificationDefinitions(definitions); } catch { return definitions; } });
	onMount(() => { staged = (command.attributes ?? []).map(value => ({ ...value })); return () => { alive = false; }; });
	function label(value: AttributeValue) {
		const definition = labels.find(item => item.id === value.attribute_id);
		return definition ? `${specificationLabel(definition.code, definition, i18n.locale)}${definition.canonical_unit ? ` (${definition.canonical_unit})` : ''}` : m.unknownSpecification;
	}
	function display(value: AttributeValue) {
		return value.number_value !== null ? formatDecimal(value.number_value, i18n.locale) : value.text_value !== null ? value.text_value : value.boolean_value ? m.yes : m.no;
	}
	async function load() {
		if (disabled || busy || wrongIdentity || admin.status !== 'ready') return;
		const session = admin.credentials(); busy = true; failed = false;
		try {
			const current = await readProductSpecificationReview(session, command);
			if (alive && session.userId === admin.session?.user.id) { review = current; failed = false; }
		} catch (error) { if (alive) failed = true; await admin.permissionFailure(error); }
		finally { if (alive) busy = false; }
	}
	function confirm() {
		if (disabled || busy || wrongIdentity || failed || !review || admin.status !== 'ready' || !editor?.prepare()) return;
		try {
			const replacement = replaceReviewedProductCommand(sessionStorage, command, review, staged);
			review = null; failed = false; storageFailed = false;
			onreviewed(replacement);
		} catch { storageFailed = true; }
	}
</script>

<div class="space-y-4">
	<div class={formStatus}>{#if failed}<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message>{/if}</div>
	<div class={formActions}><Button type="button" variant="outline" disabled={disabled || busy || wrongIdentity} onclick={load}><ButtonLabel pending={busy} pendingLabel={m.loading} label={failed ? m.retry : m.reviewSpecifications} reserveLabels={[m.retry, m.reviewSpecifications]} /></Button></div>
	{#if review}
		<Alert.Message appearance="inline">{m.specificationMetadataKept}</Alert.Message>
		<h2 class={sectionHeading}>{m.currentValues}</h2>
		{#if review.attributes.length}
			<dl class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:ml-0 [&_dd]:wrap-break-word">{#each review.attributes as value (value.attribute_id)}<div><dt>{label(value)}</dt><dd>{display(value)}</dd></div>{/each}</dl>
		{:else}<Empty.Root><Empty.Description>{m.noAttributes}</Empty.Description></Empty.Root>{/if}
	{/if}
	<ProductAttributes bind:this={editor} productId={null} bind:definitions {family} bind:staged disabled={disabled || busy || wrongIdentity || failed || !review} />
	{#if review}<div class={formActions}><Button type="button" disabled={disabled || busy || wrongIdentity || failed} onclick={confirm}>{m.saveReviewedSpecifications}</Button></div>{/if}
	<div class={formStatus} aria-live="polite">{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive">{m.wrongIdentity}</Alert.Message>{:else if storageFailed}<Alert.Message appearance="inline" variant="destructive">{m.storage}</Alert.Message>{/if}</div>
</div>
