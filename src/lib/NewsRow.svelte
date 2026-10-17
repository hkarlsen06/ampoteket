<script lang="ts">
	import * as Item from '#lib/components/ui/item/index.js';
	import Icon from '#lib/Icon.svelte';
	import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
	import NewsImage from '#lib/NewsImage.svelte';
	import { nameWrap } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventWhen, formatPublished, type FeedEntry } from '#lib/news.js';

	// One newsroom entry as a row of an `Item.Group`: the cover above the text on phones,
	// beside it from 48rem. The title link covers the row; the row shows its focus.
	let { entry }: { entry: FeedEntry } = $props();
	const i18n = getI18n();
</script>

<Item.Root variant="row" role="listitem" class={['group/news relative grid items-start gap-x-6 gap-y-3 rounded-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring', entry.cover && 'md:grid-cols-[14rem_minmax(0,1fr)]']}>
	{#if entry.cover}<NewsImage image={entry.cover} crop class="aspect-[3/2]!" />{/if}
	<div class="grid min-w-0 gap-1.5">
		<p class="flex flex-wrap gap-x-2 text-sm text-muted-foreground"><time datetime={entry.published_at}>{formatPublished(entry.published_at, i18n.locale)}</time>{#if entry.author}<span aria-hidden="true">·</span><span><span class="sr-only">{i18n.m.news.byline(entry.author)}</span><span aria-hidden="true">{entry.author}</span></span>{/if}</p>
		<h3 class={['m-0 text-lg leading-snug font-semibold md:text-xl', nameWrap]}><a class="text-foreground no-underline group-hover/news:underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!" href={i18n.href(`/news/${entry.slug}`)}>{entry.title}</a></h3>
		{#if entry.summary}<p class="text-muted-foreground">{entry.summary}</p>{/if}
		{#if entry.event}<p class="inline-flex items-start gap-1.5 text-sm"><Icon icon={CalendarDotsIcon} size={18} class="mt-px" /><span><span class="sr-only">{i18n.m.news.event}: </span><time datetime={entry.event.starts_at}>{formatEventWhen(entry.event, i18n.locale)}</time></span></p>{/if}
	</div>
</Item.Root>
