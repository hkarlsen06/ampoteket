<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import Icon from '#lib/Icon.svelte';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import NewsImage from '#lib/NewsImage.svelte';
	import { cardLink, nameWrap } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventWhen, formatPublished, type FeedEntry } from '#lib/news.js';

	let { entry }: { entry: FeedEntry } = $props();
	const i18n = getI18n();
</script>

<Card.Root role="article" aria-labelledby={`news-${entry.id}`} class={[cardLink, 'group/news row-span-1 grid-rows-none gap-0 p-0 text-base md:p-0']}>
	{#if entry.cover}<NewsImage image={entry.cover} crop class="rounded-b-none" />{/if}
	<Card.Content class="grid min-w-0 gap-4 p-5 md:p-6">
		<div class="grid gap-2">
			<h3 id={`news-${entry.id}`} class={['m-0 text-xl leading-snug font-semibold md:text-2xl', nameWrap]}><a class="text-foreground no-underline group-hover/news:underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!" href={i18n.href(`/news/${entry.slug}`)}>{entry.title}</a></h3>
			<p class="flex flex-wrap gap-x-2 text-sm text-muted-foreground"><time datetime={entry.published_at}>{formatPublished(entry.published_at, i18n.locale)}</time>{#if entry.author}<span aria-hidden="true">·</span><span><span class="sr-only">{i18n.m.news.byline(entry.author)}</span><span aria-hidden="true">{entry.author}</span></span>{/if}</p>
		</div>
		{#if entry.summary}<p class="leading-relaxed text-muted-foreground">{entry.summary}</p>{/if}
		{#if entry.event}<p class="inline-flex items-start gap-1.5 text-sm"><Icon icon={CalendarDotsIcon} size={18} class="mt-px" /><span><span class="sr-only">{i18n.m.news.event}: </span><time datetime={entry.event.starts_at}>{formatEventWhen(entry.event, i18n.locale)}</time></span></p>{/if}
	</Card.Content>
</Card.Root>
