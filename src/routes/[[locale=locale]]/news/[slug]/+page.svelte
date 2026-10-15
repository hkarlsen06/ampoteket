<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import EventRow from '#lib/EventRow.svelte';
	import NewsImage from '#lib/NewsImage.svelte';
	import NewsLinks from '#lib/NewsLinks.svelte';
	import NewsPeople from '#lib/NewsPeople.svelte';
	import { lede, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatNewsDate, paragraphs } from '#lib/news.js';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.news);
	const article = $derived(data.article);
	const [cover, ...gallery] = $derived(article?.images ?? []);
</script>

<svelte:head>
	{#if article}
		<title>{m.articleTitle(article.title)}</title>
		{#if article.summary}<meta name="description" content={article.summary} /><meta property="og:description" content={article.summary} />{/if}
		<meta property="og:title" content={article.title} /><meta property="og:type" content="article" />
	{:else}<title>{m.title}</title>{/if}
</svelte:head>
<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	{#if !article}
		<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>
		<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
		<Button variant="outline" href={i18n.href(`/news/${page.params.slug}`)} data-sveltekit-reload>{m.retry}</Button>
	{:else}
		<article class="grid gap-6">
			<header class={[pageHeader, 'mb-0']}>
				<h1 class={pageHeading}>{article.title}</h1>
				{#if article.summary}<p class={lede}>{article.summary}</p>{/if}
				<p class="text-sm text-muted-foreground"><time datetime={article.published_at}>{formatNewsDate(article.published_at, i18n.locale)}</time></p>
			</header>
			{#if cover}<NewsImage image={cover} eager />{/if}
			{#if article.event}
				<aside class="grid gap-3 rounded-xl border p-4 md:p-5" aria-labelledby="event-title">
					<h2 id="event-title" class="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Icon icon={CalendarDotsIcon} />{m.event}</h2>
					<EventRow event={article.event} tile />
				</aside>
			{/if}
			<div class="grid max-w-[var(--measure)] gap-4 text-[1.0625rem] leading-relaxed">
				{#each paragraphs(article.body) as paragraph, index (index)}<p class="whitespace-pre-line">{paragraph}</p>{/each}
			</div>
			{#if gallery.length}
				<ul class="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
					{#each gallery as image (image.id)}<li><NewsImage {image} /></li>{/each}
				</ul>
			{/if}
		</article>
		{#if article.people.length}
			<section class={section({ spacing: 'divided' })} aria-labelledby="people-title">
				<Separator />
				<h2 id="people-title" class={sectionHeading}>{m.people}</h2>
				<NewsPeople people={article.people} />
			</section>
		{/if}
		{#if article.links.length}
			<section class={section({ spacing: 'divided' })} aria-labelledby="links-title">
				<Separator />
				<h2 id="links-title" class={sectionHeading}>{m.links}</h2>
				<NewsLinks links={article.links} />
			</section>
		{/if}
	{/if}
	<div class={section()}><Button variant="link" href={i18n.href('/news')}><Icon icon={ArrowLeftIcon} />{m.allNews}</Button></div>
</div>
