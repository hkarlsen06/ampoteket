<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
	import { itemTitle } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatEventHours, formatEventWhen, OSLO, type EventSummary } from '#lib/news.js';

	// One event in a list. `tile` adds the date block for lists not grouped by day,
	// where the full date is also in the text; a day-grouped list shows hours only.
	let { event, tile = false, headingLevel = 3 }: { event: EventSummary; tile?: boolean; headingLevel?: 2 | 3 | 4 } = $props();
	const i18n = getI18n();
	const parts = $derived(new Intl.DateTimeFormat(i18n.locale === 'nb' ? 'nb-NO' : 'en-GB', { timeZone: OSLO, day: 'numeric', month: 'short' }).formatToParts(new Date(event.starts_at)));
	const day = $derived(parts.find(part => part.type === 'day')?.value);
	const month = $derived(parts.find(part => part.type === 'month')?.value.replace('.', ''));
</script>

<div class={['grid items-start gap-4', tile && 'grid-cols-[3.5rem_minmax(0,1fr)]']}>
	{#if tile}
		<div class="grid justify-items-center rounded-lg border bg-card py-1.5 leading-tight" aria-hidden="true">
			<span class="text-sm text-muted-foreground">{month}</span>
			<span class="text-2xl font-bold">{day}</span>
		</div>
	{/if}
	<div class="grid min-w-0 gap-1">
		<svelte:element this={`h${headingLevel}`} class={itemTitle}><a href={i18n.href(`/events/${event.slug}`)}>{event.title}</a></svelte:element>
		<p class="text-muted-foreground"><time datetime={event.starts_at}>{tile ? formatEventWhen(event, i18n.locale) : formatEventHours(event, i18n.locale)}</time></p>
		{#if event.location}<p class="inline-flex items-center gap-1.5 text-muted-foreground"><Icon icon={MapPinIcon} /><span class="sr-only">{i18n.m.events.where}: </span>{event.location}</p>{/if}
	</div>
</div>
