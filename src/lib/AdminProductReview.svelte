<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readInventory, readProductReferences, type ProductReferences, type ProductStock } from '#lib/admin-products.js';
	import { auditActor, readActorReferences, readProductCreations, type AuditEntry, type AuditReferences } from '#lib/admin-audit.js';
	import { readNewProducts, readReviewPoint, reviewedThrough, reviewList, reviewSince, timestampMicros, writeReviewPoint, type NewProduct } from '#lib/admin-review.js';
	import { formatCountedAt, formatDecimal } from '#lib/format.js';
	import { cardGrid, formActions, formStatus, section, sectionHeading } from '#lib/ui.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import AdminProductCard from '#lib/AdminProductCard.svelte';

	// Products other staff added since this staff member last reviewed them (page-admin-stock.md).
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminReview);
	let products = $state<NewProduct[] | null>(null); let since = $state<string | null>(null);
	let references = $state<ProductReferences | null>(null); let stock = $state<Map<string, ProductStock> | null>(null);
	let creations = $state<{ entries: AuditEntry[]; actors: AuditReferences } | null>(null);
	let loading = $state(true); let failed = $state(false); let stockFailed = $state(false); let creatorsFailed = $state(false);
	let reviewed = $state(false); let visibleCount = $state(12); let heading = $state<HTMLHeadingElement | null>(null);
	let mounted = false; let generation = 0;
	const list = $derived(products && since ? reviewList(products, creations?.entries ?? null, since, admin.membership?.id ?? null) : null);
	onMount(() => { mounted = true; void load(); return () => { mounted = false; generation++; }; });
	async function load() {
		if (admin.status !== 'ready') return;
		loading = true; const version = ++generation;
		try {
			const session = admin.credentials();
			// Read the point each time, so a review marked in another tab applies here too.
			const point = reviewSince(readReviewPoint(session.userId));
			const items = await readNewProducts(session, point);
			// Stock and creators are details: without them the list still shows, never as empty.
			const [refs, inventory, created] = items.length ? await Promise.all([
				readProductReferences(session),
				readInventory(session).catch(error => { void admin.permissionFailure(error); return null; }),
				readProductCreations(session, point).then(async entries => ({ entries, actors: await readActorReferences(session, entries) }))
					.catch(error => { void admin.permissionFailure(error); return null; })
			]) : [null, [] as ProductStock[], { entries: [], actors: {} }];
			if (mounted && version === generation && admin.session?.user.id === session.userId) {
				// A review marked while this read ran stays marked; the point only moves forward.
				products = items; since = since && timestampMicros(since) > timestampMicros(point) ? since : point; references = refs;
				stock = inventory && new Map(inventory.map(row => [row.product_id, row])); stockFailed = inventory === null;
				creations = created; creatorsFailed = created === null; failed = false;
			}
		} catch (error) { if (mounted && version === generation) failed = true; await admin.permissionFailure(error); }
		finally { if (mounted && version === generation) loading = false; }
	}
	// The app owns freshness (design-system.md §4.2): re-read when the tab becomes relevant again.
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !loading) {
			revalidateQueued = false;
			untrack(() => { void load(); });
		}
	});
	$effect(() => { if (list?.length) untrack(() => { reviewed = false; }); });
	function markReviewed() {
		const through = list && reviewedThrough(list);
		if (!through) return;
		writeReviewPoint(admin.session?.user.id, through);
		since = through; reviewed = true; visibleCount = 12;
		// The button leaves with the list; keep focus in the section without scrolling.
		heading?.focus({ preventScroll: true });
	}
</script>

<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<section class={[section(), 'mb-8']} aria-labelledby="product-review-title">
	<h2 id="product-review-title" class={sectionHeading} tabindex="-1" bind:this={heading}>{list?.length ? m.headingCount(formatDecimal(String(list.length), i18n.locale)) : m.heading}</h2>
	<div class={[formStatus, !failed && !(list?.length && (stockFailed || creatorsFailed)) && 'sr-only']} aria-live="polite">
		{#if failed}<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
		{:else if list?.length}
			{#if creatorsFailed}<Alert.Message appearance="inline" variant="destructive">{m.creatorsUnavailable}</Alert.Message>{/if}
			{#if stockFailed}<Alert.Message appearance="inline" variant="destructive">{i18n.m.adminProducts.inventoryUnavailable}</Alert.Message>{/if}
		{:else if loading && !list}<span class="sr-only">{m.loading}</span>
		{:else if reviewed}<span class="sr-only">{m.reviewed}</span>{/if}
	</div>
	{#if failed || (list?.length && (stockFailed || creatorsFailed))}<Button variant="outline" disabled={loading} onclick={load}><ButtonLabel pending={loading} pendingLabel={m.loading} label={m.retry} /></Button>{/if}
	{#if list}
		{#if !list.length}<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
		{:else}
			<ul class={cardGrid} aria-labelledby="product-review-title">
				{#each list.slice(0, visibleCount) as { product, creation } (product.id)}
					{@const time = formatCountedAt(product.created_at, i18n.locale)}
					<AdminProductCard {product} {references} quantity={stock?.get(product.id)?.quantity ?? null} headingLevel={3}>
						<p class="m-0 text-sm text-muted-foreground">{creation && creations ? m.addedBy(time, auditActor(creation, i18n.locale, creations.actors)) : m.added(time)}</p>
					</AdminProductCard>
				{/each}
			</ul>
			<div class={formActions}>
				{#if list.length > visibleCount}<Button variant="outline" onclick={() => { visibleCount += 12; }}>{i18n.m.catalog.showMore}</Button>{/if}
				<Button variant="outline" onclick={markReviewed}>{m.markReviewed}</Button>
			</div>
		{/if}
	{:else if !failed}<Skeleton class="h-48 w-full" />{/if}
</section>
