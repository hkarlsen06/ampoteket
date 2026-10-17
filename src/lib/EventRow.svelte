<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
	import { itemTitle, nameWrap } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventHours, formatEventShort, formatEventWhen, OSLO, type EventSummary } from '#lib/news.js';

	// One event in a list. `tile` adds a date mark for lists not grouped by day; the
	// text beside it then gives the weekday and hours, and screen readers the full date.
	// A day-grouped list shows hours only. The title link covers the row.
	let { event, tile = false, headingLevel = 3 }: { event: EventSummary; tile?: boolean; headingLevel?: 2 | 3 | 4 } = $props();
	const i18n = getI18n();
	const parts = $derived(new Intl.DateTimeFormat(i18n.locale === 'nb' ? 'nb-NO' : 'en-GB', { timeZone: OSLO, day: 'numeric', month: 'short' }).formatToParts(new Date(event.starts_at)));
	const day = $derived(parts.find(part => part.type === 'day')?.value);
	const month = $derived(parts.find(part => part.type === 'month')?.value.replace('.', ''));
</script>

<div class={['group/event relative grid items-start gap-x-4 gap-y-1 rounded-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring', tile && 'grid-cols-[2.75rem_minmax(0,1fr)]']}>
	{#if tile}
		<div class="grid justify-items-center leading-none tabular-nums" aria-hidden="true">
			<span class="text-sm text-muted-foreground">{month}</span>
			<span class="mt-1 text-2xl font-bold">{day}</span>
		</div>
	{/if}
	<div class="grid min-w-0 gap-1">
		<svelte:element this={`h${headingLevel}`} class={[itemTitle, nameWrap]}><a class="text-foreground no-underline group-hover/event:underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-none! focus-visible:outline-none!" href={i18n.href(`/events/${event.slug}`)}>{event.title}</a></svelte:element>
		<p class="text-muted-foreground"><time datetime={event.starts_at}>{#if tile}<span class="sr-only">{formatEventWhen(event, i18n.locale)}</span><span aria-hidden="true">{formatEventShort(event, i18n.locale)}</span>{:else}{formatEventHours(event, i18n.locale)}{/if}</time></p>
		{#if event.location}<p class="inline-flex items-center gap-1.5 text-muted-foreground"><Icon icon={MapPinIcon} size={18} /><span class="sr-only">{i18n.m.events.where}: </span>{event.location}</p>{/if}
	</div>
</div>
