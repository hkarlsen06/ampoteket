<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import NewsImage from '#lib/NewsImage.svelte';
	import NewsLinks from '#lib/NewsLinks.svelte';
	import NewsPeople from '#lib/NewsPeople.svelte';
	import { itemTitle, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventWhen, monthKey, monthOf, paragraphs } from '#lib/news.js';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.events);
	const event = $derived(data.event);
	const [cover, ...gallery] = $derived(event?.images ?? []);
</script>

<svelte:head>
	{#if event}<title>{m.eventTitle(event.title)}</title><meta property="og:title" content={event.title} />{:else}<title>{m.title}</title>{/if}
</svelte:head>
<div class={pageContainer({ width: 'reading', padding: 'page' })}>
	{#if !event}
		<header class={pageHeader}><h1 class={pageHeading}>{m.heading}</h1></header>
		<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
		<Button variant="outline" href={i18n.href(`/events/${page.params.slug}`)} data-sveltekit-reload>{m.retry}</Button>
	{:else}
		<article class="grid gap-6">
			<header class={[pageHeader, 'mb-0']}>
				<h1 class={pageHeading}>{event.title}</h1>
				<dl class="grid gap-2 text-[1.0625rem]">
					<div class="flex items-start gap-2"><dt><Icon icon={CalendarDotsIcon} class="mt-1" /><span class="sr-only">{m.when}</span></dt><dd><time datetime={event.starts_at}>{formatEventWhen(event, i18n.locale)}</time></dd></div>
					{#if event.location}<div class="flex items-start gap-2"><dt><Icon icon={MapPinIcon} class="mt-1" /><span class="sr-only">{m.where}</span></dt><dd>{event.location}</dd></div>{/if}
				</dl>
			</header>
			{#if cover}<NewsImage image={cover} eager />{/if}
			{#if event.description}
				<div class="grid max-w-[var(--measure)] gap-4 text-[1.0625rem] leading-relaxed">
					{#each paragraphs(event.description) as paragraph, index (index)}<p class="whitespace-pre-line">{paragraph}</p>{/each}
				</div>
			{/if}
			{#if event.article}
				<aside class="grid justify-items-start gap-2 rounded-xl border p-4 md:p-5">
					<p class={itemTitle}>{event.article.title}</p>
					{#if event.article.summary}<p class="text-muted-foreground">{event.article.summary}</p>{/if}
					<Button variant="link" href={i18n.href(`/news/${event.article.slug}`)}>{m.article}<Icon icon={ArrowRightIcon} /></Button>
				</aside>
			{/if}
			{#if gallery.length}
				<ul class="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
					{#each gallery as image (image.id)}<li><NewsImage {image} /></li>{/each}
				</ul>
			{/if}
		</article>
		{#if event.people.length}
			<section class={section({ spacing: 'divided' })} aria-labelledby="people-title">
				<Separator />
				<h2 id="people-title" class={sectionHeading}>{i18n.m.news.people}</h2>
				<NewsPeople people={event.people} />
			</section>
		{/if}
		{#if event.links.length}
			<section class={section({ spacing: 'divided' })} aria-labelledby="links-title">
				<Separator />
				<h2 id="links-title" class={sectionHeading}>{i18n.m.news.links}</h2>
				<NewsLinks links={event.links} />
			</section>
		{/if}
	{/if}
	<div class={section()}><Button variant="link" href={i18n.href(event ? `/events?month=${monthKey(monthOf(event.starts_at))}` : '/events')}><Icon icon={ArrowLeftIcon} />{m.allEvents}</Button></div>
</div>
