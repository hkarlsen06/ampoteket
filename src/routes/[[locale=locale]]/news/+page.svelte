<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import EventRow from '#lib/EventRow.svelte';
	import NewsRow from '#lib/NewsRow.svelte';
	import { formActions, pageContainer, sectionHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.news);
	const nextHref = $derived(data.feed?.next ? i18n.href(`/news?${new URLSearchParams({ before: data.feed.next.published_at, id: data.feed.next.id })}`) : null);
</script>

<svelte:head><title>{m.title}</title><meta name="description" content={m.description} /><meta property="og:title" content={m.title} /><meta property="og:description" content={m.description} />{#if data.older}<meta name="robots" content="noindex" />{/if}</svelte:head>
<div class={pageContainer({ padding: 'page' })}>
	<!-- The two section headings say what the page is; the h1 is for screen readers. -->
	<h1 class="sr-only">{m.heading}</h1>
	<!-- Articles in the main column and what is coming up beside them from 64rem; on
	     narrower screens the events come first, as in the document order. -->
	<div class={['grid max-w-3xl gap-12', !data.older && 'lg:max-w-none lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-x-14']}>
		{#if !data.older}
			<section class="min-w-0 space-y-2 lg:col-start-2 lg:row-start-1" aria-labelledby="upcoming-title">
				<h2 id="upcoming-title" class={sectionHeading}>{m.upcoming}</h2>
				{#if data.upcoming === null}
					<Alert.Message appearance="inline" variant="destructive">{i18n.m.events.unavailable}</Alert.Message>
				{:else if !data.upcoming.length}
					<p class="py-2 text-muted-foreground">{m.noUpcoming}</p>
				{:else}
					<Item.Group>
						{#each data.upcoming as event, index (event.id)}
							{#if index > 0}<Item.Separator />{/if}
							<Item.Root variant="row" role="listitem"><EventRow {event} tile /></Item.Root>
						{/each}
					</Item.Group>
				{/if}
				<Button variant="link" href={i18n.href('/events')}>{m.calendar}<Icon icon={ArrowRightIcon} /></Button>
			</section>
		{/if}
		<section class="min-w-0 space-y-2 lg:col-start-1 lg:row-start-1" aria-labelledby="articles-title">
			<h2 id="articles-title" class={sectionHeading}>{m.articles}</h2>
			{#if data.feed === null}
				<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
				<Button variant="outline" href={i18n.href('/news')} data-sveltekit-reload>{m.retry}</Button>
			{:else if !data.feed.entries.length}
				<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
			{:else}
				<Item.Group>
					{#each data.feed.entries as entry, index (entry.id)}
						{#if index > 0}<Item.Separator />{/if}
						<NewsRow {entry} />
					{/each}
				</Item.Group>
			{/if}
			{#if data.older || nextHref}
				<div class={formActions}>
					{#if data.older}<Button variant="link" href={i18n.href('/news')}><Icon icon={ArrowLeftIcon} />{m.newest}</Button>{/if}
					{#if nextHref}<Button variant="link" href={nextHref}>{m.older}<Icon icon={ArrowRightIcon} /></Button>{/if}
				</div>
			{/if}
		</section>
	</div>
</div>
