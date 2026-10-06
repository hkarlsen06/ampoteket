<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import SlidersHorizontalIcon from 'phosphor-svelte/lib/SlidersHorizontalIcon';
	import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { cardLink, pageContainer, pageHeader, pageHeading, formActions, formStatus, sheetBody, shelfPickerSheet } from '#lib/ui.js';
	import { goto, refreshAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { readCatalogPage, readCatalogFacets, type CatalogProduct } from '#lib/catalog.js';
	import {
		canonicalFilterNumber, CatalogQueryError, hasCatalogFilters,
		parseCatalogQuery, serializeCatalogQuery,
		type CatalogFacet, type CatalogConditions, type CatalogQueryIssue
	} from '#lib/catalog-search.js';
	import { compareDecimals } from '#lib/decimal.js';
	import { categoryLabel, specificationLabel, getI18n } from '#lib/i18n/index.js';
	import SpecNumberFilter from '#lib/SpecNumberFilter.svelte';
	import LabelShelfSelection from '#lib/LabelShelfSelection.svelte';
	import { readShelfTopology, type ShelfTopology } from '#lib/shelf-map.js';
	import ProductIdentity from '#lib/ProductIdentity.svelte';
	import ProductPrice from '#lib/ProductPrice.svelte';
	import ProductAvailability from '#lib/ProductAvailability.svelte';
	import CategoryGraphic from '#lib/CategoryGraphic.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.catalog);
	const shop = $derived(i18n.m.shop);
	function restoredDraft(queryString: string) {
		try { return parseCatalogQuery(new URLSearchParams(queryString)); }
		catch {
			const params = new URLSearchParams(queryString);
			return { q: params.get('q') ?? '', categories: params.getAll('category'), conditions: {},
				cabinetIds: params.getAll('cabinet'), binIds: params.getAll('bin') };
		}
	}
	// The first render, including no-JS SSR, contains the submitted values.
	const initialDraft = untrack(() => restoredDraft(data.queryString));
	let facets = $state<{ categories: string[]; attributes: CatalogFacet[] }>({ categories: [], attributes: [] });
	let facetsLoading = $state(true);
	let facetsFailed = $state(false);
	let facetsCycle = $state(0);
	let topology = $state<ShelfTopology | null>(null);
	let topologyLoading = $state(false);
	let topologyFailed = $state(false);
	let topologyCycle = $state(0);
	let loading = $state(false);
	let failed = $state(false);
	let complete = $state(false);
	let pagingError = $state<CatalogQueryIssue | null>(null);
	let pagingController: AbortController | undefined;
	let expandedProducts = $state<CatalogProduct[] | null>(null);
	let pagination = $state<HTMLElement>();
	let filtersOpen = $state(false);
	let locationsOpen = $state(false);
	let q = $state(initialDraft.q);
	let categories = $state(initialDraft.categories);
	let cabinetIds = $state(initialDraft.cabinetIds);
	let binIds = $state(initialDraft.binIds);
	let conditions = $state<CatalogConditions>(initialDraft.conditions);
	let filterSnapshot = $state<{
		categories: string[]; conditions: CatalogConditions;
		formError: CatalogQueryIssue | null; invalidField: string | null;
	} | null>(null);
	let formError = $state<CatalogQueryIssue | null>(null);
	// Search text typed but not yet submitted survives Back and reload.
	export const snapshot = { capture: () => q, restore: (value: string) => { q = value; } };
	let invalidField = $state<string | null>(null);
	const configKey = $derived(data.config ? `${data.config.url}\n${data.config.publishableKey}` : '');
	const submitted = $derived.by(() => {
		try { return parseCatalogQuery(new URLSearchParams(data.queryString)); }
		catch { return null; }
	});
	// Native GET search and enhanced search preserve the same submitted filters.
	const queryFields = $derived([...new URLSearchParams(data.queryString)]
		.filter(([key]) => ['category', 'cabinet', 'bin'].includes(key) || /^(eq|min|max)\./.test(key)));
	const selectedBins = $derived(topology?.bins.filter((bin) => cabinetIds.includes(bin.cabinet_id) || binIds.includes(bin.id)).map((bin) => bin.id) ?? []);
	const locationCount = $derived(cabinetIds.length + binIds.length);
	const filtered = $derived(submitted ? hasCatalogFilters(submitted) : false);
	const ready = $derived(Boolean(data.initialPage) && !data.queryError);
	const categoryChoices = $derived(facets.categories);
	const restoredProducts = $derived(page.state.catalog?.queryString === data.queryString ? page.state.catalog.products : null);
	const displayed = $derived(expandedProducts ?? restoredProducts ?? data.initialPage?.products ?? []);
	const queryError = $derived(data.queryError ?? pagingError);
	const nextAfter = $derived(complete || !displayed.length ? null : displayed.at(-1)!.code);
	const unavailable = $derived(data.unavailable || failed);

	// Only navigation replaces drafts; page/facet retries preserve user input.
	$effect(() => {
		const queryString = data.queryString;
		untrack(() => {
			const query = restoredDraft(queryString);
			q = query.q; categories = [...query.categories]; conditions = structuredClone(query.conditions);
			cabinetIds = [...query.cabinetIds]; binIds = [...query.binIds];
			formError = null; invalidField = null;
		});
	});
	$effect(() => {
		void data.queryString;
		const initialPage = data.initialPage;
		untrack(() => {
			pagingController?.abort();
			expandedProducts = null; complete = initialPage?.complete ?? false;
			loading = false; failed = false; pagingError = null;
		});
		return () => pagingController?.abort();
	});

	$effect(() => {
		void configKey; void facetsCycle;
		const selected = categories.length === 1 ? [...categories] : [];
		const config = untrack(() => data.config);
		if (!config) { facetsLoading = false; return; }
		const controller = new AbortController();
		facetsLoading = true; facetsFailed = false;
		readCatalogFacets(config, { categories: selected, signal: controller.signal }).then((result) => {
			if (!controller.signal.aborted) { facets = result; facetsLoading = false; }
		}).catch(() => {
			if (!controller.signal.aborted) { facetsFailed = true; facetsLoading = false; }
		});
		return () => controller.abort();
	});

	$effect(() => {
		void configKey; void topologyCycle;
		if (!locationsOpen) return;
		const config = untrack(() => data.config);
		if (!config) return;
		const controller = new AbortController();
		topologyLoading = true; topologyFailed = false;
		readShelfTopology(config, { signal: controller.signal }).then((result) => {
			if (!controller.signal.aborted) { topology = result; topologyLoading = false; }
		}).catch(() => {
			if (!controller.signal.aborted) { topologyFailed = true; topologyLoading = false; }
		});
		return () => controller.abort();
	});

	// Picking a drawer is a new search by placement; clearing keeps the rest of the search.
	async function showLocation(binId: string | null) {
		locationsOpen = false; resetExpanded();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch query for goto().
		const params = binId ? new URLSearchParams({ bin: binId }) : new URLSearchParams(data.queryString);
		params.delete('cabinet'); params.delete('after');
		if (!binId) params.delete('bin');
		await goto(i18n.href('/p') + (params.size ? `?${params}` : ''), { reset: false });
	}

	async function showMore() {
		if (!data.config || !submitted || loading || queryError || !nextAfter) return;
		const own = new AbortController(); pagingController = own;
		const previous = displayed;
		loading = true; failed = false;
		try {
			const following = await readCatalogPage(data.config, {
				query: { ...submitted, after: nextAfter }, limit: 50, signal: own.signal
			});
			if (own.signal.aborted) return;
			const ids = new Set(previous.map(product => product.product_id));
			const codes = new Set(previous.map(product => product.code));
			if (following.products.some(product => ids.has(product.product_id) || codes.has(product.code))) throw new Error('Repeated catalog page');
			expandedProducts = [...previous, ...following.products];
			complete = following.complete;
			// Restore visible rows before SvelteKit restores the reading position on Back.
			saveState({ ...page.state, catalog: { queryString: data.queryString, products: $state.snapshot(expandedProducts) } });
		} catch (error) {
			if (!own.signal.aborted) {
				failed = true;
				pagingError = error instanceof CatalogQueryError ? error.issue : null;
			}
		} finally { if (!own.signal.aborted) loading = false; }
	}

	function resetExpanded() {
		expandedProducts = null;
		saveState({ ...page.state, catalog: undefined });
	}

	// Deprecated replaceState, not goto({ shallow }): a shallow goto is a navigation and
	// cancels a link the visitor clicked while more rows were loading. Revisit for SvelteKit 4.
	function saveState(state: App.PageState) {
		void replaceState(page.url.href, state);
	}

	$effect(() => {
		if (!pagination || !ready || loading || failed || queryError || !nextAfter || typeof IntersectionObserver === 'undefined') return;
		// Reobserve after each append so a tall viewport can fill naturally.
		void displayed.length;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) showMore();
		}, { rootMargin: '0px 0px 300px 0px' });
		observer.observe(pagination);
		return () => observer.disconnect();
	});

	function loadMore(event: MouseEvent) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		showMore();
	}

	function setCondition(code: string, operator: 'eq' | 'min' | 'max', value: string | undefined) {
		const next = { ...conditions[code] };
		if (value === undefined) delete next[operator];
		else next[operator] = value;
		conditions = { ...conditions, [code]: next };
	}

	// Numeric drafts hold only bounds; an eq shorthand from a restored link
	// dissolves into the two bounds on the first edit.
	function setBound(code: string, bound: 'min' | 'max', value: string | undefined) {
		const previous = conditions[code] ?? {};
		const next: { min?: string; max?: string } = {};
		const min = bound === 'min' ? value : previous.min ?? previous.eq;
		const max = bound === 'max' ? value : previous.max ?? previous.eq;
		if (min !== undefined) next.min = min;
		if (max !== undefined) next.max = max;
		conditions = { ...conditions, [code]: next };
	}

	function openFilters() {
		filterSnapshot = {
			categories: [...categories],
			conditions: structuredClone($state.snapshot(conditions)),
			formError,
			invalidField
		};
		filtersOpen = true;
	}

	function toggleCategory(value: string, checked: boolean) {
		categories = checked ? [...categories, value] : categories.filter((category) => category !== value);
		conditions = {}; formError = null; invalidField = null;
	}

	function clearCategories() {
		categories = []; conditions = {}; formError = null; invalidField = null;
	}

	function cancelFilters() {
		if (filterSnapshot) {
			categories = [...filterSnapshot.categories];
			conditions = structuredClone($state.snapshot(filterSnapshot.conditions));
			formError = filterSnapshot.formError;
			invalidField = filterSnapshot.invalidField;
		}
		filtersOpen = false;
	}

	async function submitSearch(event: SubmitEvent, applyFilters = false) {
		event.preventDefault();
		if (!data.config || (applyFilters && (facetsLoading || facetsFailed))) return;
		invalidField = null;
		const canonical: CatalogConditions = Object.create(null);
		try {
			if (applyFilters) for (const [code, condition] of Object.entries(conditions)) {
				const definition = facets.attributes.find((facet) => facet.code === code)?.definition;
				if (!definition) throw new CatalogQueryError('unknownAttribute');
				const values: CatalogConditions[string] = {};
				for (const operator of ['eq', 'min', 'max'] as const) {
					const value = condition[operator];
					if (value === undefined || (definition.value_type === 'number' && !value.trim())) continue;
					try {
						values[operator] = definition.value_type === 'number'
							? canonicalFilterNumber(value, 0, i18n.locale) : value;
					} catch { invalidField = `${operator}-${code}`; throw new CatalogQueryError('invalidFilter'); }
				}
				if (values.eq !== undefined && (values.min !== undefined || values.max !== undefined)) {
					invalidField = `eq-${code}`; throw new CatalogQueryError('invalidFilter');
				}
				if (values.min !== undefined && values.max !== undefined && compareDecimals(values.min, values.max) > 0) {
					invalidField = `min-${code}`; throw new CatalogQueryError('invalidFilter');
				}
				// Equal bounds are the slider's exact selection; keep eq as its URL form.
				if (definition.value_type === 'number' && values.min !== undefined && values.max !== undefined
					&& compareDecimals(values.min, values.max) === 0) canonical[code] = { eq: values.min };
				else if (Object.keys(values).length) canonical[code] = values;
			}
			const params = applyFilters
				? serializeCatalogQuery({ q: '', categories, cabinetIds, binIds, conditions: canonical, after: '' })
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch query for goto().
				: new URLSearchParams(queryFields);
			if (q.trim()) params.set('q', q.trim());
			parseCatalogQuery(params);
			formError = null; resetExpanded(); filterSnapshot = null; filtersOpen = false;
			await goto(i18n.href('/p') + (params.size ? `?${params}` : ''), { reset: false });
		} catch (error) {
			formError = error instanceof CatalogQueryError ? error.issue : 'invalidFilter';
			if (invalidField) document.getElementById(invalidField)?.focus();
		}
	}

	// A shortcut shows only its category; tapping a selected one removes it. Either
	// way the specification conditions, which belong to the old selection, go.
	function categoryHref(name: string) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch query for a link.
		const params = new URLSearchParams(data.queryString);
		const selected = params.getAll('category');
		for (const key of [...params.keys()]) if (key === 'category' || key === 'after' || /^(eq|min|max)\./.test(key)) params.delete(key);
		for (const category of selected.includes(name) ? selected.filter(category => category !== name) : [name]) params.append('category', category);
		return i18n.href('/p') + (params.size ? `?${params}` : '');
	}

	function pageHref(after = '') {
		if (!submitted) return i18n.href('/p');
		const params = serializeCatalogQuery({ ...submitted, after });
		return i18n.href('/p') + (params.size ? `?${params}` : '');
	}

	async function refresh() {
		if (failed && !pagingError) { await showMore(); return; }
		resetExpanded(); await refreshAll();
	}
</script>

<svelte:head>
	<title>{m.title}</title>
	<meta name="description" content={m.description} />
	<meta property="og:title" content={m.title} />
	<meta property="og:description" content={m.description} />
</svelte:head>

<div class={pageContainer({ padding: 'page' })}>
	<div class={pageHeader}>
		<h1 class={pageHeading}>{m.heading}</h1>
	</div>

	<!-- Two ways in, like a login screen's alternatives: search, or pick a drawer.
	A hairline carries «eller» where the row is too narrow; Filtre narrows either. -->
	<div class="grid max-w-152 gap-3 lg:flex lg:max-w-none lg:items-end lg:gap-4">
		<form class="grid gap-3 lg:w-152 lg:min-w-0" method="GET" action={i18n.href('/p')} onsubmit={submitSearch}>
			{#each queryFields as [name, value], index (index)}<input type="hidden" {name} {value} />{/each}
			<Field.Field>
				<Field.Label for="catalog-search">{m.searchLabel}</Field.Label>
				<!-- Submit lives inside the field, so the two can never wrap apart. -->
				<InputGroup.Root>
					<InputGroup.Input id="catalog-search" class="min-w-0" name="q" type="search" inputmode="search" autocomplete="off" autocapitalize="none" enterkeyhint="search" maxlength={200} placeholder={m.searchPlaceholder} bind:value={q} />
					<InputGroup.Addon align="inline-end">
						<InputGroup.Button class="search-submit" type="submit" disabled={!data.config}><Icon icon={MagnifyingGlassIcon} aria-hidden="true" />{m.search}</InputGroup.Button>
					</InputGroup.Addon>
				</InputGroup.Root>
			</Field.Field>
			{#if data.codeError}<Field.Error role="alert">{m.invalidCode}</Field.Error>{/if}
		</form>
		<div class="no-js:hidden flex items-center gap-3 text-sm text-muted-foreground lg:min-h-12">
			<Separator class="flex-1 lg:hidden" /><span>{m.or}</span><Separator class="flex-1 lg:hidden" />
		</div>
		<Dialog.Root bind:open={locationsOpen}>
			<Dialog.Trigger disabled={!data.config}>
				{#snippet child({ props })}
					<Button {...props} variant="outline" class="location-toggle no-js:hidden w-full lg:w-auto" aria-controls="catalog-locations" disabled={!data.config}>
						<Icon icon={MapPinIcon} aria-hidden="true" />
						{locationCount ? m.locationSelected(locationCount) : m.location}
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<!-- A bottom sheet on phones, a right-hand panel from 48rem; the map never scrolls. -->
			<Dialog.Content id="catalog-locations" variant="sheet" preventScroll={false} showCloseButton={false} class={shelfPickerSheet} aria-describedby={undefined}>
				<Dialog.Header layout="bar">
					<Dialog.Title>{m.location}</Dialog.Title>
					<div class="flex shrink-0 items-center gap-1">
						{#if locationCount}<Button variant="ghost" size="sm" onclick={() => showLocation(null)}>{i18n.m.adminLabels.clearSelection}</Button>{/if}
						<Dialog.Close>
							{#snippet child({ props })}<Button {...props} variant="ghost" size="icon" aria-label={m.closeLocations}><Icon icon={XIcon} class="size-5" aria-hidden="true" /></Button>{/snippet}
						</Dialog.Close>
					</div>
				</Dialog.Header>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (the named scroll region must be keyboard-scrollable) -->
				<div class={[sheetBody, 'grid content-start gap-5']} role="region" tabindex="0" aria-label={m.location}>
					{#if topologyLoading && !topology}<p role="status" class="sr-only">{i18n.m.shelfMap.loading}</p>{/if}
					{#if topologyFailed}
						<div class="grid justify-items-start gap-3">
							<Alert.Message role="alert" appearance="inline" variant="destructive">{i18n.m.shelfMap.unavailable}</Alert.Message>
							<Button variant="outline" onclick={() => topologyCycle++}>{m.retry}</Button>
						</div>
					{/if}
					{#if topology}
						<LabelShelfSelection {topology} heading={null} selected={selectedBins} onpick={(id) => showLocation(id)} disabled={topologyLoading || topologyFailed} />
					{/if}
				</div>
			</Dialog.Content>
		</Dialog.Root>
	</div>
	<div class={[formActions, "mt-3"]}>
		<Dialog.Root open={filtersOpen} onOpenChange={(open) => { if (open) openFilters(); else cancelFilters(); }}>
			<Dialog.Trigger disabled={!data.config}>
				{#snippet child({ props })}
					<Button {...props} variant="outline" class="filter-toggle no-js:hidden" aria-controls="catalog-filters" disabled={!data.config}>
						<Icon icon={SlidersHorizontalIcon} aria-hidden="true" />
						{categories.length ? m.filtersSelected(categories.length) : m.filters}
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<!-- A bottom sheet on phones like Hyllekart beside it, so «Vis resultater» is at the thumb; centred from 48rem. -->
			<Dialog.Content id="catalog-filters" preventScroll={false} showCloseButton={false} class="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl gap-0 p-0 md:max-w-2xl max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-w-full max-md:translate-y-0 max-md:rounded-b-none" aria-describedby={undefined}>
				<form class="grid max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]" onsubmit={(event) => submitSearch(event, true)}>
					<Dialog.Header layout="bar">
						<Dialog.Title>{m.filterTitle}</Dialog.Title>
						<Dialog.Close>
							{#snippet child({ props })}<Button {...props} variant="ghost" size="icon" aria-label={m.closeFilters}><Icon icon={XIcon} class="size-5" aria-hidden="true" /></Button>{/snippet}
						</Dialog.Close>
					</Dialog.Header>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (the named scroll region must be keyboard-scrollable) -->
					<div class={[sheetBody, 'filter-dialog-body grid gap-5']} role="region" tabindex="0" aria-label={m.filterOptions}>
					{#if facetsLoading}<p role="status" class="sr-only">{m.loadingFilters}</p>{/if}
					{#if facetsFailed}<div class="grid justify-items-start gap-3"><Alert.Message role="alert" appearance="inline" variant="destructive">{m.filtersUnavailable}</Alert.Message><Button variant="outline" onclick={() => facetsCycle++}>{m.retry}</Button></div>{/if}
					<Field.Set class="gap-3" disabled={facetsLoading || facetsFailed}>
						<Field.Legend class="mb-0">{m.category}</Field.Legend>
						<div class="grid gap-0 md:grid-cols-2 md:gap-x-6">
							{#each categoryChoices as name (name)}
								<div class="relative">
									<Field.Label for={`category-${name}`} class="min-h-12 w-full items-center gap-3 py-2 font-normal">
										<Checkbox id={`category-${name}`} name="category" value={name} checked={categories.includes(name)}
											onCheckedChange={(checked) => toggleCategory(name, checked)} />
										<span>{categoryLabel(name, i18n.locale)}</span>
									</Field.Label>
									<Separator class="absolute inset-x-0 bottom-0" />
								</div>
							{/each}
						</div>
						{#if categories.length}<Button variant="ghost" class="justify-self-start" onclick={clearCategories}>{m.allCategories}</Button>{/if}
					</Field.Set>
					{#if categories.length === 1 || Object.keys(conditions).length}
						{#each facets.attributes.filter((facet) => categories.length === 1 || Object.hasOwn(conditions, facet.code)) as facet (facet.code)}
						{#if facet.definition.value_type === 'number'}
							<Field.Set class="relative gap-3 pt-4">
								<Field.Legend class="mb-0">{specificationLabel(facet.code, facet.definition, i18n.locale)}</Field.Legend>
								<Separator class="absolute inset-x-0 top-0" />
								<SpecNumberFilter {facet} condition={conditions[facet.code] ?? {}} ready={!facetsLoading && !facetsFailed}
									onbound={(bound, value) => setBound(facet.code, bound, value)} />
							</Field.Set>
						{:else}
							<Field.Field>
								<Field.Label for={`eq-${facet.code}`}>{specificationLabel(facet.code, facet.definition, i18n.locale)}</Field.Label>
								<NativeSelect.Root class="w-full" id={`eq-${facet.code}`} name={`eq.${facet.code}`} disabled={facetsLoading || facetsFailed} value={conditions[facet.code]?.eq === undefined ? '' : `:${conditions[facet.code].eq}`} onchange={(event) => setCondition(facet.code, 'eq', event.currentTarget.value ? event.currentTarget.value.slice(1) : undefined)}>
									<option value="">{m.anyValue}</option>
									{#if facet.definition.value_type === 'boolean'}
										<option value=":true">{shop.yes}</option><option value=":false">{shop.no}</option>
									{:else}
										{#if conditions[facet.code]?.eq !== undefined && !facet.values.includes(conditions[facet.code].eq!)}<option value={`:${conditions[facet.code].eq}`}>{conditions[facet.code].eq}</option>{/if}
										{#each facet.values as value (value)}<option value={`:${value}`}>{value || m.emptyValue}</option>{/each}
									{/if}
								</NativeSelect.Root>
							</Field.Field>
						{/if}
					{/each}
					{:else if categories.length > 1}<p class="text-sm text-muted-foreground">{m.singleCategoryForSpecifications}</p>
					{:else}<p class="text-sm text-muted-foreground">{m.chooseCategory}</p>{/if}
						{#if formError}<Field.Error id="filter-error" role="alert">{m.errors[formError]}</Field.Error>{/if}
					</div>
					<Dialog.Footer variant="sheet">
						<Button variant="ghost" onclick={cancelFilters}>{m.cancel}</Button>
						<Button type="submit" disabled={facetsLoading || facetsFailed}>{m.applyFilters}</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog.Root>
		{#if filtered || queryError}<Button variant="link" href={i18n.href('/p')} data-sveltekit-reset={false}>{m.clearFilters}</Button>{/if}
	</div>
	{#if data.categories?.length}
		<nav class="mt-3" aria-label={m.category}>
			<ul class="m-0 flex list-none flex-wrap gap-2 p-0">
				{#each data.categories as name (name)}
					{@const selected = submitted?.categories.includes(name) ?? false}
					<li class="max-w-full"><Button class="max-w-full wrap-anywhere" variant={selected ? 'default' : 'outline'} size="sm" href={categoryHref(name)} data-sveltekit-reset={false} aria-current={selected ? 'true' : undefined}>
						{#if selected}<Icon icon={CheckIcon} aria-hidden="true" />{/if}{categoryLabel(name, i18n.locale)}
					</Button></li>
				{/each}
			</ul>
		</nav>
	{/if}
	{#if formError && !filtersOpen}<Field.Error class="mt-3" role="alert">{m.errors[formError]}</Field.Error>{/if}
	<noscript><p class="mt-4">{m.noScript} <a href={i18n.href('/p')}>{m.browseUnfiltered}</a></p></noscript>

	{#if !data.queryError}
		{#if displayed.length}
			<ul class="cards m-0 mt-6 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3" aria-label={m.results}>
				{#each displayed as product (product.product_id)}
					<li class="row-span-2 grid min-w-0 grid-rows-subgrid">
					<Card.Root class="{cardLink} ring-0">
						<Card.Header class="grid grid-cols-[minmax(0,1fr)_5rem] content-start items-start gap-3 p-0">
							<ProductIdentity {product} showCategory stretchLink />
							<div class="h-16"><CategoryGraphic category={product.category_name} /></div>
						</Card.Header>
						<Card.Content class="grid gap-2 p-0">
							<ProductPrice {product} />
							<ProductAvailability {product} plain />
						</Card.Content>
					</Card.Root>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
	<div role="status" aria-live="polite" aria-atomic="true">
		{#if ready && !queryError && !displayed.length}
			<Empty.Root class="mt-6"><Empty.Description>{filtered ? m.noMatches : submitted?.after ? m.endOfBrowse : m.emptyCatalog}</Empty.Description></Empty.Root>
		{/if}
	</div>
	<!-- Takes no space until a read fails. After the results, so a failed next page
	is reported where the reader is and nothing above them moves. -->
	<div class={formStatus} role="status" aria-live="polite" aria-atomic="true">
		{#if queryError}<Alert.Message appearance="inline" variant="destructive">{m.errors[queryError]}</Alert.Message>
		{:else if unavailable}<Alert.Message appearance="inline" variant="destructive">{displayed.length ? m.previousRead : m.unavailable}</Alert.Message>{/if}
	</div>
	{#if unavailable}<Button variant="outline" class="no-js:hidden" onclick={refresh} disabled={loading}>{m.retry}</Button>{/if}
	<nav class="pagination mt-8 flex min-h-12 flex-wrap items-center gap-4" aria-label={m.pagination} bind:this={pagination}>
		{#if nextAfter && !queryError}<Button variant="outline" href={pageHref(nextAfter)} data-sveltekit-reset={false} onclick={loadMore}><span class="no-js:hidden">{m.showMore}</span><span class="hidden no-js:inline">{m.next}</span></Button>{/if}
		<p class="text-sm text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
			{#if ready && !queryError && displayed.length}{m.shownCount(displayed.length)}{/if}{#if loading}<span class="sr-only">{m.loadingSearch}</span>{/if}
		</p>
		{#if submitted?.after || pagingError === 'missingCursor'}<Button variant="link" href={pageHref()} data-sveltekit-reset={false}>{m.firstPage}</Button>{/if}
	</nav>
</div>
