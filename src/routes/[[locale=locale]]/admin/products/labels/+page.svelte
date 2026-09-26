<script lang="ts">
	import { codeText, formActions, formLayout, formStatus, pageHeader, pageHeading, section, sectionHeading } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as AspectRatio from '$lib/components/ui/aspect-ratio';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Field from '$lib/components/ui/field';
	import { onMount, tick, untrack } from 'svelte';
	import { normalizeDecimal } from '$lib/decimal';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { productName } from '$lib/catalog';
	import LabelShelfSelection from '$lib/LabelShelfSelection.svelte';
	import { readLabelData, selectedLabelProducts, labelSpecificationLines, type LabelData } from '$lib/labels/data';
	import { proportionalLabelSettings } from '$lib/labels/settings';
	import type { PreparedLabels } from '$lib/labels/render';
	import type { Fetcher } from '$lib/api';
	const fieldId = $props.id();
	const i18n = getI18n(), admin = getAdminContext();
	const m = $derived(i18n.m.adminLabels);
	let data = $state<LabelData | null>(null), loading = $state(true), failed = $state(false), generating = $state(false);
	let selected = $state<string[]>([]), includeUnplaced = $state(false);
	// Millimetres from 32 to 81 in steps of 0.1, typed as text so either decimal mark works.
	let widthText = $state('45'), widthChecked = $state(false);
	const width = $derived.by(() => {
		try {
			const value = normalizeDecimal(widthText, i18n.locale), number = Number(value);
			return /^\d+(?:\.\d)?$/.test(value) && number >= 32 && number <= 81 ? number : undefined;
		} catch { return undefined; }
	});
	const dimensions = $derived(proportionalLabelSettings(width ?? NaN));
	let prepared = $state<PreparedLabels | null>(null), downloadUrl = $state('');
	let previewLines = $state<Record<string, string[]>>({});
	let error = $state('');
	let alive = true, controller: AbortController | null = null;
	const products = $derived(data ? selectedLabelProducts(data, selected, includeUnplaced) : []);
	const unplaced = $derived(data?.products.filter(product => product.bin_id === null).length ?? 0);
	const inactive = $derived(products.filter(product => !product.is_active).length);
	// Any changed selection, width or language invalidates the
	// prior file. A download always belongs to the visible configuration.
	const configuration = $derived(JSON.stringify({ selected, includeUnplaced, width, locale: i18n.locale }));
	$effect(() => { void configuration; untrack(() => { clearPreview(); if (generating) controller?.abort(); }); });
	function clearPreview() {
		if (downloadUrl) URL.revokeObjectURL(downloadUrl);
		downloadUrl = ''; prepared = null; previewLines = {};
	}
	onMount(() => { void load(); return () => { alive = false; controller?.abort(); clearPreview(); }; });
	let revalidateQueued = $state(false);
	function refresh() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(loading || generating)) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});

	async function read(signal: AbortSignal): Promise<LabelData> {
		const session = admin.credentials(), cleanups: (() => void)[] = [], requests: AbortController[] = [];
		// Link navigation cancellation to each request while retaining its existing
		// 15-second timeout, including response-body reads on older phone browsers.
		const fetcher: Fetcher = (input, init) => {
			signal.throwIfAborted();
			const linked = new AbortController();
			requests.push(linked);
			for (const source of [signal, init?.signal]) if (source) {
				const abort = () => linked.abort();
				if (source.aborted) abort(); else source.addEventListener('abort', abort, { once: true });
				cleanups.push(() => source.removeEventListener('abort', abort));
			}
			return fetch(input, { ...init, signal: linked.signal });
		};
		try {
			const next = await readLabelData(session, fetcher);
			signal.throwIfAborted();
			if (!alive || session.userId !== admin.session?.user.id || admin.status !== 'ready') throw new Error('Label read identity changed');
			return next;
		} catch (cause) {
			// One failed branch must also stop its parallel reads before removing
			// their parent/timeout links. Preserve the original diagnostic.
			requests.forEach(request => request.abort()); throw cause;
		} finally { cleanups.forEach(cleanup => cleanup()); }
	}
	async function load() {
		if (generating || controller) return;
		const operation = new AbortController(); controller = operation; loading = true;
		try {
			const next = await read(operation.signal);
			if (JSON.stringify(next) !== JSON.stringify(data)) clearPreview();
			data = next; failed = false;
			const live = new Set(next.references.shelf.bins.map(bin => bin.id));
			if (selected.some(id => !live.has(id))) { selected = selected.filter(id => live.has(id)); error = m.selectionChanged; }
		} catch (cause) {
			operation.abort();
			if (alive) { failed = true; clearPreview(); await admin.permissionFailure(cause); }
		} finally { if (alive) loading = false; if (controller === operation) controller = null; }
	}
	async function generate() {
		if (generating || loading || failed || !data) return;
		if (width === undefined) { widthChecked = true; void tick().then(() => document.getElementById(`${fieldId}-width`)?.focus()); return; }
		clearPreview(); error = ''; generating = true;
		const operation = new AbortController(); controller = operation;
		const snapshot = configuration;
		let resolving = true;
		try {
			const next = await read(operation.signal);
			if (snapshot !== configuration) return;
			resolving = false;
			data = next;
			const live = new Set(next.references.shelf.bins.map(bin => bin.id));
			if (selected.some(id => !live.has(id))) { selected = selected.filter(id => live.has(id)); error = m.selectionChanged; return; }
			const chosen = selectedLabelProducts(next, selected, includeUnplaced);
			if (!chosen.length) { error = m.empty; return; }
			const labels = chosen.map(product => ({ id: product.id, code: product.code,
				lines: labelSpecificationLines(next, product, i18n.locale, null) }));
			const { prepareLabels } = await import('$lib/labels/render');
			const result = await prepareLabels(labels, { ...dimensions, copies: 1, cutGuides: true }, operation.signal);
			operation.signal.throwIfAborted();
			if (!alive || snapshot !== configuration) return;
			prepared = result; previewLines = Object.fromEntries(labels.map(label => [label.id, label.lines]));
			downloadUrl = URL.createObjectURL(new Blob([new Uint8Array(result.pdfBytes)], { type: 'application/pdf' }));
		} catch (cause) {
			if (!alive || operation.signal.aborted) return;
			operation.abort();
			const failure = cause && typeof cause === 'object' && 'kind' in cause ? cause as { kind: string; code?: string } : null;
			if (resolving) failed = true;
			error = resolving ? m.unavailable : failure?.kind === 'settings' ? m.settingsError : failure?.kind === 'empty' ? m.empty
				: failure?.kind === 'limit' ? m.limitError : failure?.kind === 'overflow' ? m.overflow(failure.code ?? '')
					: failure?.kind === 'character' ? m.characterError(failure.code ?? '') : m.generationFailed;
			await admin.permissionFailure(cause);
		} finally { if (alive) generating = false; if (controller === operation) controller = null; }
	}
</script>

<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={refresh} ononline={refresh} />
<svelte:document onvisibilitychange={refresh} />
<div class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></div>
<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
{#if failed}<Button type="button" variant="outline" class="mb-6" onclick={load} disabled={loading}>{m.retry}</Button>{/if}
{#if data}
	<LabelShelfSelection topology={data.references.shelf} {selected} onselection={(ids) => { selected = ids; }}
		onselectall={() => { includeUnplaced = true; }} onclear={() => { includeUnplaced = false; }} disabled={generating} />
	{#if unplaced}
		<p>{m.unplaced(unplaced)}</p>
		<Field.Field orientation="horizontal"><Checkbox id="checkbox-includeUnplaced" name="checkbox-includeUnplaced" bind:checked={includeUnplaced} disabled={generating} /><Field.Label for="checkbox-includeUnplaced" class="cursor-pointer">{m.includeUnplaced}</Field.Label></Field.Field>
	{/if}
	<form class={[formLayout, 'mt-6']} novalidate onsubmit={(event) => { event.preventDefault(); void generate(); }}>
		<Field.Field data-invalid={widthChecked && width === undefined}>
			<Field.Label for={`${fieldId}-width`}>{m.width} <span class="sr-only">(mm)</span></Field.Label>
			<InputGroup.Root class="max-w-40"><InputGroup.Input id={`${fieldId}-width`} type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" required disabled={generating} bind:value={widthText}
				aria-invalid={widthChecked && width === undefined} aria-describedby={widthChecked && width === undefined ? `${fieldId}-width-error ${fieldId}-width-hint` : `${fieldId}-width-hint`} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>mm</InputGroup.Text></InputGroup.Addon></InputGroup.Root>
			<Field.Description id={`${fieldId}-width-hint`}>{m.dimensionsHint}</Field.Description>
			{#if widthChecked && width === undefined}<Field.Error id={`${fieldId}-width-error`}>{m.widthInvalid}</Field.Error>{/if}
		</Field.Field>
		<div>
			<p aria-live="polite">{m.summary(products.length, inactive)}</p>
			{#if inactive}<p class="text-sm">{m.inactiveHint}</p>{/if}
		</div>
		<div class={formActions}><Button type="submit" variant="default" disabled={generating || loading || failed || !products.length}><ButtonLabel pending={generating} pendingLabel={m.generating} label={m.generate} /></Button>
			<span class:invisible={!generating} inert={!generating} aria-hidden={!generating}><Button variant="outline" type="button" onclick={() => controller?.abort()}>{m.cancel}</Button></span>
		</div>
	</form>
	<div class={formStatus} aria-live="polite">{#if error}<Alert.Message appearance="inline" variant="destructive" role="status">{error}</Alert.Message>{/if}</div>
	{#if prepared && downloadUrl}
		<section class={section()} aria-labelledby="label-preview-heading">
			<h2 class={sectionHeading} id="label-preview-heading">{m.previewHeading}</h2>
			<p role="status">{m.ready(prepared.totalLabels, prepared.pages, prepared.columns, prepared.rows)}</p>
			<Button variant="outline" href={downloadUrl} download="ampoteket-labels.pdf">{m.download}</Button>
			<p class="text-sm">{m.printHint}</p>
			<p>{m.previewHint}</p>
			<div class="mt-6 flex flex-wrap items-start gap-6">{#each prepared.labels as label (label.id)}
				<figure class="m-0 w-full min-w-0" style:max-width={`${width}mm`}>
					<AspectRatio.Root ratio={(width ?? 45) / label.height}><img class="block h-full w-full bg-[var(--paper)] object-contain" src={label.svgUrl} alt={m.previewAlt(label.code, (previewLines[label.id] ?? []).join(', '))} width={(width ?? 45) * 4} height={label.height * 4} /></AspectRatio.Root>
					<figcaption class="mt-2 text-sm wrap-break-word"><span class={codeText}>{label.code}</span>{#each data.products.filter(item => item.id === label.id) as product (product.id)}<br />{productName(product, i18n.locale)}{/each}</figcaption>
				</figure>
			{/each}</div>
		</section>
	{/if}
{:else if loading}
	<span class="sr-only" role="status">{m.loading}</span>
	<Skeleton class="min-h-80" aria-hidden="true" />
{/if}
