<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import EventRow from '#lib/EventRow.svelte';
	import NewsCard from '#lib/NewsCard.svelte';
	import { cardGrid, formActions, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.news);
	const nextHref = $derived(data.feed?.next ? i18n.href(`/news?${new URLSearchParams({ before: data.feed.next.published_at, id: data.feed.next.id })}`) : null);
</script>

<svelte:head><title>{m.title}</title><meta name="description" content={m.description} /><meta property="og:title" content={m.title} /><meta property="og:description" content={m.description} />{#if data.older}<meta name="robots" content="noindex" />{/if}</svelte:head>
<div class={pageContainer({ padding: 'page' })}>
	<header class={pageHeader}>
		<h1 class={pageHeading}>{m.heading}</h1>
	</header>
	{#if !data.older}
		<section class="space-y-4" aria-labelledby="upcoming-title">
			<h2 id="upcoming-title" class={sectionHeading}>{m.upcoming}</h2>
			{#if data.upcoming === null}
				<Alert.Message appearance="inline" variant="destructive">{i18n.m.events.unavailable}</Alert.Message>
			{:else if !data.upcoming.length}
				<p class="text-muted-foreground">{m.noUpcoming}</p>
			{:else}
				<ul class="m-0 grid list-none gap-5 p-0 md:grid-cols-3">
					{#each data.upcoming as event (event.id)}<li class="min-w-0"><EventRow {event} tile /></li>{/each}
				</ul>
			{/if}
			<div class="pt-2"><Button variant="outline" href={i18n.href('/events')}><Icon icon={CalendarDotsIcon} />{m.calendar}</Button></div>
		</section>
	{/if}
	<section class={section({ class: data.older ? 'mt-0' : 'mt-12' })} aria-labelledby="articles-title">
		<h2 id="articles-title" class={sectionHeading}>{m.articles}</h2>
		{#if data.feed === null}
			<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
			<Button variant="outline" href={i18n.href('/news')} data-sveltekit-reload>{m.retry}</Button>
		{:else if !data.feed.entries.length}
			<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
		{:else}
			<ul class={[cardGrid, 'grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]']}>
				{#each data.feed.entries as entry (entry.id)}<NewsCard {entry} />{/each}
			</ul>
		{/if}
		{#if data.older || nextHref}
			<div class={formActions}>
				{#if data.older}<Button variant="link" href={i18n.href('/news')}><Icon icon={ArrowLeftIcon} />{m.newest}</Button>{/if}
				{#if nextHref}<Button variant="link" href={nextHref}>{m.older}<Icon icon={ArrowRightIcon} /></Button>{/if}
			</div>
		{/if}
	</section>
</div>
