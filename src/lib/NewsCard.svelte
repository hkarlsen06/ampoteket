<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import Icon from '#lib/Icon.svelte';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import NewsImage from '#lib/NewsImage.svelte';
	import { cardLink, nameWrap } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventWhen, formatNewsDate, type FeedEntry } from '#lib/news.js';

	// One newsroom entry; the title link covers the card. Renders one <li>.
	let { entry }: { entry: FeedEntry } = $props();
	const i18n = getI18n();
</script>

<li class="grid min-w-0">
	<Card.Root class={[cardLink, 'row-span-1 grid-rows-none content-start gap-3']}>
		{#if entry.cover}<NewsImage image={entry.cover} crop />{/if}
		<div class="grid min-w-0 gap-1.5">
			<p class="text-sm text-muted-foreground"><time datetime={entry.published_at}>{formatNewsDate(entry.published_at, i18n.locale)}</time></p>
			<h3 class={['m-0 text-lg leading-snug font-semibold', nameWrap]}><a class="text-foreground no-underline hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!" href={i18n.href(`/news/${entry.slug}`)}>{entry.title}</a></h3>
			{#if entry.summary}<p class="text-muted-foreground">{entry.summary}</p>{/if}
			{#if entry.event}<p class="inline-flex items-start gap-1.5 text-sm"><Icon icon={CalendarDotsIcon} class="mt-0.5" /><span><span class="sr-only">{i18n.m.news.event}: </span><time datetime={entry.event.starts_at}>{formatEventWhen(entry.event, i18n.locale)}</time></span></p>{/if}
		</div>
	</Card.Root>
</li>
