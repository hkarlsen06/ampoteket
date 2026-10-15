<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import NewspaperIcon from 'phosphor-svelte/lib/NewspaperIcon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import EventRow from '#lib/EventRow.svelte';
	import { formActions, pageContainer, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { eventDays, formatDay, formatMonth, monthGrid, monthKey, osloDay, type CalendarEvent } from '#lib/news.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.events);
	const weeks = $derived(monthGrid(data.month));
	const key = $derived(monthKey(data.month));
	const today = osloDay(new Date());
	// Each event under every day it touches, in start order.
	const byDay = $derived.by(() => {
		const days: Record<string, CalendarEvent[]> = {};
		for (const event of data.events ?? []) for (const day of eventDays(event)) (days[day] ??= []).push(event);
		return days;
	});
	const listed = $derived(Object.entries(byDay).filter(([day]) => day.startsWith(key)).sort(([a], [b]) => a.localeCompare(b)));
	const monthHref = (month: { year: number; month: number }) => i18n.href(`/events?month=${monthKey(month)}`);
</script>

<svelte:head><title>{m.title}</title><meta name="description" content={m.description} /><meta property="og:title" content={m.title} /><meta property="og:description" content={m.description} /></svelte:head>
<div class={pageContainer({ padding: 'page' })}>
	<header class={pageHeader}>
		<h1 class={pageHeading}>{m.heading}</h1>
		<Button variant="link" href={i18n.href('/news')}><Icon icon={NewspaperIcon} />{m.news}</Button>
	</header>
	<section class="space-y-4" aria-labelledby="month-title">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 id="month-title" class={sectionHeading} aria-live="polite">{formatMonth(data.month, i18n.locale)}</h2>
			<nav aria-label={m.months} class={formActions}>
				{#if key !== monthKey(data.current)}<Button variant="link" href={i18n.href('/events')}>{m.thisMonth}</Button>{/if}
				{#if data.previous}<Button variant="outline" size="icon" href={monthHref(data.previous)} aria-label={m.previous}><Icon icon={CaretLeftIcon} /></Button>{/if}
				{#if data.next}<Button variant="outline" size="icon" href={monthHref(data.next)} aria-label={m.next}><Icon icon={CaretRightIcon} /></Button>{/if}
			</nav>
		</div>
		{#if data.events === null}
			<Alert.Message appearance="inline" variant="destructive">{m.unavailable}</Alert.Message>
			<Button variant="outline" href={i18n.href(`/events?month=${key}`)} data-sveltekit-reload>{m.retry}</Button>
		{:else}
			<!-- Phones see dots; from 48rem the titles fit. Days with events link to their list below. -->
			<table class="w-full table-fixed border-collapse text-sm">
				<caption class="sr-only">{formatMonth(data.month, i18n.locale)}</caption>
				<thead>
					<tr>{#each m.weekdays as weekday, index (index)}<th scope="col" class="pb-2 text-center font-medium text-muted-foreground md:text-left md:pl-2"><span aria-hidden="true">{weekday}</span><span class="sr-only">{m.weekdayNames[index]}</span></th>{/each}</tr>
				</thead>
				<tbody>
					{#each weeks as week (week[0].day)}
						<tr>
							{#each week as { day, inMonth } (day)}
								{@const events = inMonth ? byDay[day] ?? [] : []}
								<td class={['h-12 border p-0 align-top md:h-28', !inMonth && 'bg-muted/40 text-muted-foreground']}>
									<div class="grid h-full content-start justify-items-center gap-1 p-1 md:justify-items-start md:p-2">
										{#if events.length}
											<a href={`#day-${day}`} class={['inline-grid min-h-8 min-w-8 place-items-center rounded-md font-semibold', day === today && 'outline-2 outline-foreground']}>
												{Number(day.slice(8))}<span class="sr-only">, {formatDay(day, i18n.locale)}{day === today ? `, ${m.today}` : ''}: {m.dayEvents(events.length)}</span>
											</a>
											<span class="flex gap-0.5 md:hidden" aria-hidden="true">{#each events.slice(0, 3) as event (event.id)}<span class="size-1.5 rounded-full bg-primary"></span>{/each}</span>
											<ul class="m-0 hidden w-full min-w-0 list-none space-y-1 p-0 md:block">
												{#each events.slice(0, 2) as event (event.id)}<li class="truncate"><a href={i18n.href(`/events/${event.slug}`)} class="text-foreground no-underline hover:underline">{event.title}</a></li>{/each}
												{#if events.length > 2}<li class="text-muted-foreground" aria-hidden="true">+{events.length - 2}</li>{/if}
											</ul>
										{:else}
											<span class={['inline-grid min-h-8 min-w-8 place-items-center rounded-md', day === today && 'font-semibold outline-2 outline-foreground']}>{Number(day.slice(8))}{#if day === today}<span class="sr-only">, {m.today}</span>{/if}</span>
										{/if}
									</div>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
	{#if data.events !== null}
		<section class={section({ class: 'mt-10 space-y-8' })} aria-labelledby="month-title">
			{#if !listed.length}
				<Empty.Root><Empty.Description>{m.empty}</Empty.Description></Empty.Root>
			{:else}
				{#each listed as [day, events] (day)}
					<div class="grid gap-4">
						<h3 id={`day-${day}`} class="text-lg font-semibold">{formatDay(day, i18n.locale)}</h3>
						<ul class="m-0 grid list-none gap-5 p-0">
							{#each events as event (event.id)}<li><EventRow {event} headingLevel={4} /></li>{/each}
						</ul>
					</div>
				{/each}
			{/if}
		</section>
	{/if}
</div>
