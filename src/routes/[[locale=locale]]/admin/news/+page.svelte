<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formActions, itemTitle, pageHeader, pageHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import Icon from '#lib/Icon.svelte';
	import NewspaperIcon from 'phosphor-svelte/lib/NewspaperIcon';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import StateBadge from '#lib/StateBadge.svelte';
	import { onMount, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readAdminNews, type AdminArticle, type AdminEvent } from '#lib/admin-news.js';
	import { formatEventWhen } from '#lib/news.js';

	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminNews);
	let news = $state<{ articles: AdminArticle[]; events: AdminEvent[] } | null>(null);
	let failed = $state(false); let busy = $state(false);
	async function load() {
		if (busy || admin.status !== 'ready') return; busy = true;
		try { const session = admin.credentials(); const rows = await readAdminNews(session); if (session.userId === admin.userId) { news = rows; failed = false; } }
		catch (error) { failed = true; await admin.permissionFailure(error); } finally { busy = false; }
	}
	onMount(() => { void load(); });
	// The app owns freshness (design-system.md §4.2): re-read on return to the tab.
	let revalidateQueued = $state(false);
	function revalidate() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => { if (revalidateQueued && admin.status === 'ready' && !busy) { revalidateQueued = false; untrack(() => { void load(); }); } });
	const latest = (entry: { article: AdminArticle | null; event: AdminEvent | null }) => Math.max(...[entry.article, entry.event].map(row => (row ? Date.parse(row.updated_at) : 0)));
	// An article and its event are one entry, edited together; the latest change first.
	const entries = $derived.by(() => {
		if (!news) return [];
		const articles = new Map(news.articles.map(article => [article.id, article]));
		const linked = new Map(news.events.filter(event => event.article_id && articles.has(event.article_id)).map(event => [event.article_id!, event]));
		return [
			...news.articles.map(article => ({ id: article.id, article, event: linked.get(article.id) ?? null })),
			...news.events.filter(event => !event.article_id || !articles.has(event.article_id)).map(event => ({ id: event.id, article: null, event }))
		].sort((a, b) => latest(b) - latest(a));
	});
</script>
<svelte:head><title>{m.title}</title></svelte:head>
<svelte:window onfocus={revalidate} ononline={revalidate} />
<svelte:document onvisibilitychange={revalidate} />
<header class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<div class={formActions}>
		<Button href={i18n.href('/admin/news/new?with=article')}><Icon icon={NewspaperIcon} />{m.newArticle}</Button>
		<Button variant="outline" href={i18n.href('/admin/news/new?with=event')}><Icon icon={CalendarDotsIcon} />{m.newEvent}</Button>
		<Button variant="link" href={i18n.href('/news')}>{m.viewPublic}</Button>
	</div>
</header>
{#if failed && news !== null}<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message><Button type="button" variant="outline" disabled={busy} onclick={load}><ButtonLabel pending={busy} pendingLabel={i18n.m.admin.retrying} label={i18n.m.admin.retry} /></Button>{/if}
{#if news === null}
	{#if busy}<span class="sr-only" role="status">{i18n.m.admin.loading}</span>{/if}
	<div class="min-h-80 space-y-4" aria-busy={busy}>
		{#if busy || !failed}{#each [1, 2, 3] as row (row)}<div class="space-y-3 py-3" aria-hidden="true"><Skeleton class="h-6 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>{/each}
		{:else}<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load}>{i18n.m.admin.retry}</Button>{/if}
	</div>
{:else if !entries.length}<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
{:else}
	<Item.Group>
		{#each entries as entry, index (entry.id)}
			{#if index > 0}<Item.Separator />{/if}
			<Item.Root variant="row" role="listitem">
				<Item.Content class="min-w-0 basis-60 gap-2">
					<Item.Title class={itemTitle}>{entry.article?.title ?? entry.event?.title}</Item.Title>
					<Item.Description class="grid gap-1.5">
						{#if entry.article}
							<span class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class="inline-flex items-center gap-1.5 text-foreground"><Icon icon={NewspaperIcon} />{m.article}</span><StateBadge tone={entry.article.is_published ? 'success' : 'neutral'}>{entry.article.is_published ? m.published : m.unpublished}</StateBadge></span>
						{/if}
						{#if entry.event}
							<span class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class="inline-flex items-center gap-1.5 text-foreground"><Icon icon={CalendarDotsIcon} />{m.event}</span><StateBadge tone={entry.event.is_published ? 'success' : 'neutral'}>{entry.event.is_published ? m.published : m.unpublished}</StateBadge><time datetime={entry.event.starts_at}>{formatEventWhen(entry.event, i18n.locale)}</time></span>
						{/if}
					</Item.Description>
				</Item.Content>
				<Item.Actions><Button variant="outline" size="sm" href={i18n.href(`/admin/news/${entry.id}`)}>{m.edit}<span class="sr-only"> {entry.article?.title ?? entry.event?.title}</span></Button></Item.Actions>
			</Item.Root>
		{/each}
	</Item.Group>
{/if}
