<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { formatDecimal, formatMoney, unitLabel } from '#lib/format.js';
	import { itemTitle, sectionHeading } from '#lib/ui.js';
	import { salesAxis } from '#lib/admin-statistics.js';

	type Day = { date: string; sale_count: string; total_nok: string; quantity: string | null };
	let { days, product = false, unit = '' }: { days: Day[]; product?: boolean; unit?: string } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.adminStatistics);
	const metric = $derived(product ? m.quantitySold : m.saleCount);
	const plot = $derived(salesAxis(days.map((day) => product ? day.quantity ?? '0' : day.sale_count), !product));
	const data = $derived(days.map((day, index) => ({ ...day, amount: plot.points[index] })));
	const config = $derived({ amount: { label: metric, color: 'var(--link)' } } satisfies Chart.ChartConfig);
	const dateFormat = $derived(new Intl.DateTimeFormat(i18n.locale === 'nb' ? 'nb-NO' : 'en-GB', {
		timeZone: 'Europe/Oslo', day: 'numeric', month: 'short'
	}));
	const maximum = $derived(formatDecimal(plot.maximum, i18n.locale) + (product && unit ? ` ${unitLabel(unit, i18n.locale, plot.maximum)}` : ''));
	function dateLabel(date: string) { return dateFormat.format(new Date(`${date}T12:00:00Z`)); }
	const tickDateFormat = $derived(new Intl.DateTimeFormat(i18n.locale === 'nb' ? 'nb-NO' : 'en-GB', { timeZone: 'Europe/Oslo', day: 'numeric', month: 'numeric' }));
	function dateTick(date: string) { return tickDateFormat.format(new Date(`${date}T12:00:00Z`)); }
	function axisLabel(point: number) { return formatDecimal(plot.ticks.find(tick => tick.point === point)?.value ?? '0', i18n.locale); }
	const axisWidth = $derived(Math.max(36, ...plot.ticks.map(tick => axisLabel(tick.point).length * 8 + 12)));
</script>

<div class="grid min-w-0 gap-3">
	<h2 class={sectionHeading}>{m.chartTitle}</h2>
	<p class="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
		<span>{metric}</span><span>{m.maximum(maximum)}</span>
	</p>
	<Chart.Container {config} class="h-64 w-full min-w-0 aspect-auto" role="img" aria-label={`${m.chartTitle}. ${metric}. ${m.maximum(maximum)}`}>
		<BarChart
			{data} x="date" y="amount" yDomain={[0, 1000]} yNice={false}
			series={[{ key: 'amount', label: metric, color: 'var(--color-amount)' }]}
			axis={true} rule={false} motion="none" highlight={false}
			padding={{ left: axisWidth, right: 20, top: 8, bottom: 28 }}
			props={{
				xAxis: { ticks: days.filter((_, index) => index % 7 === 0).map((day) => day.date), format: dateTick, tickOcclusion: { padding: 12, priority: 'start-end' } },
				yAxis: { ticks: plot.ticks.map(tick => tick.point), format: axisLabel },
				bars: { radius: 2, opacity: 1, strokeWidth: 0 }
			}}
		>
			{#snippet tooltip({ context })}
				<Chart.Tooltip labelFormatter={(date) => dateLabel(String(date))}>
					{#snippet formatter()}
						{#if context.tooltip.data}
							{@const day = context.tooltip.data as Day}
							<dl class="grid gap-2">
								<div><dt class="text-muted-foreground">{m.saleCount}</dt><dd class="font-mono">{formatDecimal(day.sale_count, i18n.locale)}</dd></div>
								{#if product}<div><dt class="text-muted-foreground">{m.quantitySold}</dt><dd class="font-mono">{formatDecimal(day.quantity ?? '0', i18n.locale)} {unitLabel(unit, i18n.locale, day.quantity ?? '0')}</dd></div>{/if}
								<div><dt class="text-muted-foreground">{m.value}</dt><dd class="font-mono">{formatMoney(day.total_nok, i18n.locale)}</dd></div>
							</dl>
						{/if}
					{/snippet}
				</Chart.Tooltip>
			{/snippet}
		</BarChart>
	</Chart.Container>
	<Collapsible.Root>
		<DisclosureTrigger>{m.dailyData}</DisclosureTrigger>
		<Collapsible.Content>
			<Item.Group>
				{#each days as day, index (day.date)}
					{#if index > 0}<Item.Separator />{/if}
					<Item.Root variant="row" role="listitem" class="items-start md:flex-nowrap">
						<Item.Title class={[itemTitle, 'w-full md:w-32 md:shrink-0']}><time datetime={day.date}>{dateLabel(day.date)}</time></Item.Title>
						<dl class="grid min-w-0 flex-1 grid-cols-2 gap-4 md:grid-cols-3">
							<div class="min-w-0"><dt class="text-sm text-muted-foreground">{m.saleCount}</dt><dd class="font-mono wrap-anywhere">{formatDecimal(day.sale_count, i18n.locale)}</dd></div>
							{#if product}<div class="min-w-0"><dt class="text-sm text-muted-foreground">{m.quantitySold}</dt><dd class="font-mono wrap-anywhere">{formatDecimal(day.quantity ?? '0', i18n.locale)} {unitLabel(unit, i18n.locale, day.quantity ?? '0')}</dd></div>{/if}
							<div class="min-w-0"><dt class="text-sm text-muted-foreground">{m.value}</dt><dd class="font-mono wrap-anywhere">{formatMoney(day.total_nok, i18n.locale)}</dd></div>
						</dl>
					</Item.Root>
				{/each}
			</Item.Group>
		</Collapsible.Content>
	</Collapsible.Root>
</div>
