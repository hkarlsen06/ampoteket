<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { gridCell, gridRange } from '#lib/format.js';

	// The two coordinates a buyer walks along on the one shelf wall:
	// cabinet → drawer. Rendered as labelled chips with spreadsheet-style
	// cell references (column letter + row number): Kabinett A2, Skuff C3,
	// spans as C3–D4.
	// Parts kept outside the drawer wall show one «Plassering» chip with the
	// staff note instead.
	let props: ({ outerRow: number; outerCol: number; innerRow: number; innerCol: number; rowSpan: number; colSpan: number; note?: undefined }
		| { note: string; outerRow?: undefined }) & { plain?: boolean } = $props();
	const i18n = getI18n();
	const s = $derived(i18n.m.shop);
	const entries = $derived(props.outerRow === undefined ? [{ label: s.location, value: props.note, code: false }]
		: [{ label: s.cabinet, value: gridCell(props.outerRow, props.outerCol), code: true },
			{ label: s.drawer, value: gridRange(props.innerRow, props.innerCol, props.rowSpan, props.colSpan), code: true }]);
</script>

<dl class={['loc m-0 flex flex-wrap gap-y-2', props.plain ? 'gap-x-3' : 'gap-x-2']}>
	{#each entries as location (location.label)}
		<div class="inline-flex max-w-full items-baseline gap-1.5">
			<dt class="text-sm font-semibold text-muted-foreground">{location.label}</dt>
			<dd class="m-0 text-sm wrap-anywhere"><Badge variant="secondary" class={['max-w-full whitespace-normal', location.code && 'font-mono', props.plain && 'rounded-none bg-transparent p-0']}>{location.value}</Badge></dd>
		</div>
	{/each}
</dl>
