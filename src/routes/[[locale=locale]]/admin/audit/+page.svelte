<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { auditDay, groupAudit, readAuditReferences, readAuditPage, readAuditUpdates, type AuditEntry, type AuditField, type AuditReferences } from '#lib/admin-audit.js';
	import { formatClock, formatDay } from '#lib/format.js';
	import { formStatus, itemTitle, lede, pageHeader, pageHeading, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminAudit);
	let entries = $state<AuditEntry[]>([]);
	let references = $state<AuditReferences>({});
	let loading = $state(false); let failed = $state(false); let complete = $state(false); let loaded = $state(false);
	const grouped = $derived(groupAudit(entries, i18n.locale, references));
	// The oldest loaded day may continue on the next page; it shows once it is whole.
	const days = $derived(complete || grouped.length < 2 ? grouped : grouped.slice(0, -1));
	const loadedDays = () => new Set(entries.map(entry => auditDay(entry.recordedAt))).size;
	let cursor: string | null = null;
	let alive = true; let failedRefresh = false;
	onMount(() => () => { alive = false; });

	$effect(() => { if (admin.status === 'ready' && !loaded && !loading && !failed) void loadMore(); });
	async function loadMore(refresh = false) {
		if (loading || (!refresh && complete) || admin.status !== 'ready') return;
		loading = true; failedRefresh = refresh;
		try {
			const session = admin.credentials();
			const newest = refresh ? entries[0]?.id : undefined;
			// Older pages continue until one more day is whole, so no day stops partway through its batches.
			const target = Math.max(2, loadedDays() + 1);
			do {
				const page = newest ? { entries: await readAuditUpdates(session, newest), more: !complete } : await readAuditPage(session, refresh ? null : cursor);
				const names = await readAuditReferences(session, page.entries);
				if (!alive || admin.userId !== session.userId) return;
				for (const [table, rows] of Object.entries(names)) references[table] = { ...references[table], ...rows };
				entries = newest ? [...page.entries, ...entries] : [...entries, ...page.entries];
				if (!newest) {
					if (page.entries.length) cursor = page.entries.at(-1)!.id;
					complete = !page.more;
				}
			} while (!newest && !complete && loadedDays() < target);
			loaded = true;
			failed = false;
		} catch (error) { failed = true; await admin.permissionFailure(error); }
		finally { loading = false; }
	}
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !loading) {
			revalidateQueued = false;
			untrack(() => { void loadMore(true); });
		}
	});
</script>

{#snippet clock(first: string, last: string)}
	{@const from = formatClock(first, i18n.locale)}{@const to = formatClock(last, i18n.locale)}
	<time datetime={first}>{from}</time>{#if to !== from}–<time datetime={last}>{to}</time>{/if}
{/snippet}

{#snippet changes(fields: AuditField[])}
	<Collapsible.Root class="min-w-0 max-w-full">
		<DisclosureTrigger>{m.details}</DisclosureTrigger>
		<Collapsible.Content>
			<dl class="space-y-3 pt-3 text-sm md:space-y-2">
				{#each fields as field, fieldIndex (fieldIndex)}
					<div class="grid min-w-0 gap-1 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-6"><dt class="font-semibold">{field.label}</dt><dd class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 wrap-anywhere">
						{#if field.before !== null}<del class="rounded-xs bg-destructive/15 px-1 text-destructive"><span class="sr-only">{m.before}:&nbsp;</span>{field.before}</del>{/if}
						{#if field.before !== null && field.after !== null}<span class="text-muted-foreground" aria-hidden="true">→</span>{/if}
						{#if field.after !== null}<ins class="rounded-xs bg-success/20 px-1 no-underline"><span class="sr-only">{m.after}:&nbsp;</span>{field.after}</ins>{/if}
					</dd></div>
				{/each}
			</dl>
		</Collapsible.Content>
	</Collapsible.Root>
{/snippet}

<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<svelte:head><title>{m.title}</title></svelte:head>
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<p class={lede}>{m.description}</p>
	<nav aria-label={m.related}>
		<ul class="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
			<li><Button variant="link" href={i18n.href('/admin/stock')}>{i18n.m.adminStock.heading}</Button></li>
			<li><Button variant="link" href={i18n.href('/admin/orders')}>{i18n.m.adminOrders.heading}</Button></li>
			<li><Button variant="link" href={i18n.href('/admin/counts')}>{i18n.m.adminCounts.heading}</Button></li>
			<li><Button variant="link" href={i18n.href('/admin/purchases')}>{i18n.m.admin.recoveryHeading}</Button></li>
		</ul>
	</nav>
</header>
<div class="sr-only" aria-live="polite">{#if loading && !loaded}{m.loading}{/if}</div>
{#if loading && !loaded}
	<div class="space-y-6" aria-hidden="true">{#each [1, 2, 3, 4] as row (row)}<div class="space-y-3 py-3"><div class="flex items-center gap-2"><Skeleton class="h-6 w-20" /><Skeleton class="h-5 w-40" /></div><Skeleton class="h-4 w-64 max-w-full" /><Skeleton class="h-4 w-48" /></div>{/each}</div>
{:else if loaded && !entries.length}
	<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
{:else if days.length}
	<div class="space-y-10">
		{#each days as day (day.key)}
			<section class="min-w-0" aria-labelledby={`audit-${day.key}`}>
				<h2 id={`audit-${day.key}`} class={sectionHeading}>{formatDay(day.at, i18n.locale)}</h2>
				<Item.Group>
					{#each day.batches as batch, index (batch.key)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row" role="listitem" class="min-w-0">
							<Item.Content class="min-w-0 space-y-2">
								<Item.Title class={[itemTitle, 'flex flex-wrap items-center gap-2']}><Badge variant="outline">{m.actions[batch.action]}</Badge><span class="wrap-anywhere">{batch.title}</span></Item.Title>
								<Item.Description class="space-y-1 text-sm">
									<span class="block">{@render clock(batch.first, batch.last)}</span>
									<span class="block wrap-anywhere">{m.actor}: {batch.actor}</span>
									{#if batch.summary}<span class="block wrap-anywhere">{batch.summary}</span>{/if}
								</Item.Description>
								{#if batch.events.length > 1}
									<Collapsible.Root class="min-w-0 max-w-full">
										<DisclosureTrigger>{m.showAll}</DisclosureTrigger>
										<Collapsible.Content>
											<Item.Group class="mt-2 border-l pl-4">
												{#each batch.events as event, eventIndex (event.key)}
													{#if eventIndex > 0}<Item.Separator />{/if}
													<Item.Root variant="row" role="listitem" class="min-w-0 py-3">
														<Item.Content class="min-w-0 space-y-1">
															<Item.Title class={[itemTitle, 'wrap-anywhere']}>{event.name}</Item.Title>
															<Item.Description class="text-sm">{@render clock(event.first, event.last)}</Item.Description>
															{#if event.fields.length}{@render changes(event.fields)}{/if}
														</Item.Content>
													</Item.Root>
												{/each}
											</Item.Group>
										</Collapsible.Content>
									</Collapsible.Root>
								{:else if batch.events[0].fields.length}
									{@render changes(batch.events[0].fields)}
								{/if}
							</Item.Content>
						</Item.Root>
					{/each}
				</Item.Group>
			</section>
		{/each}
	</div>
{/if}
<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>{/if}</div>
{#if failed || !complete}
	<Button type="button" variant="outline" class={failed ? undefined : 'mt-5'} onclick={() => loadMore(failed && failedRefresh)} disabled={loading}>
		<ButtonLabel pending={loading} pendingLabel={m.loading} label={failed ? m.retry : m.more} reserveLabels={[m.retry, m.more]} />
	</Button>
{/if}
