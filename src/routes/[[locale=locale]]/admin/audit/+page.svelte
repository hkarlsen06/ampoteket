<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { auditFieldDiff, readAuditPage, readAuditUpdates, type AuditEntry } from '#lib/admin-audit.js';
	import { allStaffRows } from '#lib/admin-api.js';
	import { identifier, text } from '#lib/api.js';
	import { formatCountedAt } from '#lib/format.js';
	import { codeText, formActions, formStatus, itemTitle, lede, pageHeader, pageHeading } from '#lib/ui.js';
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
	let actorNames = $state<Record<string, string>>({});
	let loading = $state(false); let failed = $state(false); let complete = $state(false); let loaded = $state(false);
	let cursor: string | null = null;
	let alive = true; let failedRefresh = false;
	onMount(() => () => { alive = false; });
	const tableName = (table: string) => (m.tables as Record<string, string>)[table] ?? table;

	$effect(() => { if (admin.status === 'ready' && !loaded && !loading && !failed) void loadMore(); });
	async function loadMore(refresh = false) {
		if (loading || (!refresh && complete) || admin.status !== 'ready') return;
		loading = true; failed = false; failedRefresh = refresh;
		try {
			const session = admin.credentials();
			const newest = refresh ? entries[0]?.id : undefined;
			const page = newest ? { entries: await readAuditUpdates(session, newest), more: !complete } : await readAuditPage(session, refresh ? null : cursor);
			const actorIds = [...new Set(page.entries.map(entry => entry.actorId).filter((id): id is string => id !== null))];
			const actors = actorIds.length ? await allStaffRows(session, 'amp_staff_members', 'id,display_name', 'id', { id: `in.(${actorIds.join(',')})` }) : [];
			if (!alive || admin.session?.user.id !== session.userId) return;
			actorNames = { ...actorNames, ...Object.fromEntries(actors.map(actor => [identifier(actor.id), text(actor.display_name, 200)])) };
			entries = newest ? [...page.entries, ...entries] : [...entries, ...page.entries];
			if (!newest) {
				if (page.entries.length) cursor = page.entries.at(-1)!.id;
				complete = !page.more;
			}
			loaded = true;
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
	<nav aria-label={m.related} class={formActions}>
		<Button variant="link" href={i18n.href('/admin/stock')}>{i18n.m.adminStock.heading}</Button>
		<Button variant="link" href={i18n.href('/admin/orders')}>{i18n.m.adminOrders.heading}</Button>
		<Button variant="link" href={i18n.href('/admin/counts')}>{i18n.m.adminCounts.heading}</Button>
		<Button variant="link" href={i18n.href('/admin/privacy')}>{i18n.m.admin.recoveryHeading}</Button>
	</nav>
</header>
<div class="sr-only" aria-live="polite">{#if loading && !loaded}<span role="status">{m.loading}</span>{/if}</div>
{#if loading && !loaded}
	<div class="space-y-6" aria-hidden="true">{#each [1, 2, 3, 4] as row (row)}<div class="space-y-3 py-3"><div class="flex items-center gap-2"><Skeleton class="h-6 w-20" /><Skeleton class="h-5 w-40" /></div><Skeleton class="h-4 w-64 max-w-full" /><Skeleton class="h-4 w-48" /></div>{/each}</div>
{:else if loaded && !entries.length}
	<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
{:else if entries.length}
	<Item.Group>
		{#each entries as entry, index (entry.id)}
			{#if index > 0}<Item.Separator />{/if}
			<Item.Root variant="row" role="listitem" class="min-w-0">
				<Item.Content class="min-w-0 space-y-2">
					<Item.Title class={[itemTitle, 'flex flex-wrap items-center gap-2']}><Badge variant="outline">{m.actions[entry.action]}</Badge><span class="wrap-anywhere">{tableName(entry.table)}</span></Item.Title>
					<Item.Description class="space-y-1 text-sm">
						<span class="block">{formatCountedAt(entry.recordedAt, i18n.locale)} · {m.entryId(entry.id)}</span>
						<span class="block wrap-anywhere">{m.actor}: {#if entry.actorId && actorNames[entry.actorId]}{actorNames[entry.actorId]}{:else}<span class={codeText}>{entry.actorId ?? entry.role}</span>{/if}</span>
					</Item.Description>
					<Collapsible.Root class="min-w-0 max-w-full">
						<DisclosureTrigger>{m.details}</DisclosureTrigger>
						<Collapsible.Content>
						<dl class="space-y-3 text-sm [&_dt]:font-semibold [&_dd]:m-0 [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_pre]:font-mono">
							<div><dt>{m.recordKey}</dt><dd><pre>{JSON.stringify(entry.key, null, 2)}</pre></dd></div>
							{#if entry.before && entry.after}
								{@const fields = auditFieldDiff(entry.before, entry.after)}
								<div><dt>{m.changes}</dt><dd><pre>{'{'}
{#each fields as field, fieldIndex (field.name)}<span class={field.changed ? undefined : 'text-muted-foreground'}>  {JSON.stringify(field.name)}: {field.prefix}{#if field.deleted}<del class="rounded-xs bg-destructive/15 px-[0.15em] text-destructive"><span class="sr-only">{m.removed} </span>{field.deleted}</del>{/if}{#if field.inserted}<ins class="rounded-xs bg-success/20 px-[0.15em]"><span class="sr-only">{m.added} </span>{field.inserted}</ins>{/if}{field.suffix}{fieldIndex < fields.length - 1 ? ',' : ''}</span>
{/each}}</pre></dd></div>
							{:else}
								{#if entry.before}<div><dt>{m.before}</dt><dd><pre>{JSON.stringify(entry.before, null, 2)}</pre></dd></div>{/if}
								{#if entry.after}<div><dt>{m.after}</dt><dd><pre>{JSON.stringify(entry.after, null, 2)}</pre></dd></div>{/if}
							{/if}
						</dl>
						</Collapsible.Content>
					</Collapsible.Root>
				</Item.Content>
			</Item.Root>
		{/each}
	</Item.Group>
{/if}
<div class={formStatus} aria-live="polite">{#if failed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message>{/if}</div>
{#if failed}<Button type="button" variant="outline" onclick={() => loadMore(failedRefresh)} disabled={loading}><ButtonLabel pending={loading} pendingLabel={m.loading} label={m.retry} /></Button>
{:else if !complete}
	<Button type="button" variant="outline" class="mt-5" onclick={() => loadMore()} disabled={loading}>
		<ButtonLabel pending={loading} pendingLabel={m.loading} label={m.more} />
	</Button>
{/if}
