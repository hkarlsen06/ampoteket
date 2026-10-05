<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { describeAudit, readAuditReferences, readAuditPage, readAuditUpdates, type AuditEntry, type AuditReferences } from '#lib/admin-audit.js';
	import { formatCountedAt } from '#lib/format.js';
	import { formStatus, itemTitle, lede, pageHeader, pageHeading } from '#lib/ui.js';
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
			const page = newest ? { entries: await readAuditUpdates(session, newest), more: !complete } : await readAuditPage(session, refresh ? null : cursor);
			const names = await readAuditReferences(session, page.entries);
			if (!alive || admin.session?.user.id !== session.userId) return;
			for (const [table, rows] of Object.entries(names)) references[table] = { ...references[table], ...rows };
			entries = newest ? [...page.entries, ...entries] : [...entries, ...page.entries];
			if (!newest) {
				if (page.entries.length) cursor = page.entries.at(-1)!.id;
				complete = !page.more;
			}
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
{:else if entries.length}
	<Item.Group>
		{#each entries as entry, index (entry.id)}
			{@const description = describeAudit(entry, i18n.locale, references)}
			{#if index > 0}<Item.Separator />{/if}
			<Item.Root variant="row" role="listitem" class="min-w-0">
				<Item.Content class="min-w-0 space-y-2">
					<Item.Title class={[itemTitle, 'flex flex-wrap items-center gap-2']}><Badge variant="outline">{m.actions[entry.action]}</Badge><span class="wrap-anywhere">{description.subject}</span></Item.Title>
					<Item.Description class="space-y-1 text-sm">
						<time class="block" datetime={entry.recordedAt}>{formatCountedAt(entry.recordedAt, i18n.locale)}</time>
						<span class="block wrap-anywhere">{m.actor}: {description.actor}</span>
						{#if description.fields.length}<span class="block wrap-anywhere">{description.fields.slice(0, 3).map(field => field.label).join(', ')}</span>{/if}
					</Item.Description>
					{#if description.fields.length}<Collapsible.Root class="min-w-0 max-w-full">
						<DisclosureTrigger>{m.details}</DisclosureTrigger>
						<Collapsible.Content>
						<dl class="grid gap-4 pt-3 text-sm md:grid-cols-2">
							{#each description.fields as field, fieldIndex (fieldIndex)}
								<div class="min-w-0"><dt class="font-semibold">{field.label}</dt><dd class="mt-1 space-y-1 wrap-anywhere">
									{#if field.before !== null}<div><span class="text-muted-foreground">{m.before}: </span><del>{field.before}</del></div>{/if}
									{#if field.after !== null}<div><span class="text-muted-foreground">{m.after}: </span><ins>{field.after}</ins></div>{/if}
								</dd></div>
							{/each}
						</dl>
						</Collapsible.Content>
					</Collapsible.Root>{/if}
				</Item.Content>
			</Item.Root>
		{/each}
	</Item.Group>
{/if}
<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>{/if}</div>
{#if failed || !complete}
	<Button type="button" variant="outline" class={failed ? undefined : 'mt-5'} onclick={() => loadMore(failed && failedRefresh)} disabled={loading}>
		<ButtonLabel pending={loading} pendingLabel={m.loading} label={failed ? m.retry : m.more} reserveLabels={[m.retry, m.more]} />
	</Button>
{/if}
