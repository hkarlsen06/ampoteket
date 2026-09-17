<script lang="ts">
	import { Slider } from '$lib/components/ui/slider';
	import { canonicalFilterNumber, type CatalogFacet } from './catalog-search';
	import { compareDecimals } from './decimal';
	import { formatMeasurement } from './format';
	import { getI18n } from './i18n';

	let { facet, condition, ready, onbound }: {
		facet: CatalogFacet;
		condition: { eq?: string; min?: string; max?: string };
		ready: boolean;
		onbound: (bound: 'min' | 'max', value: string | undefined) => void;
	} = $props();

	const i18n = getI18n();
	const m = $derived(i18n.m.catalog);
	const values = $derived(facet.values);

	// Bounds normally hold slider-written recorded values, but a restored link
	// may carry any canonical decimal, including an eq shorthand.
	function parsed(text: string | undefined): string | null {
		if (text === undefined || !text.trim()) return null;
		try { return canonicalFilterNumber(text, 0, i18n.locale); } catch { return null; }
	}
	const bounds = $derived({ min: parsed(condition.min ?? condition.eq), max: parsed(condition.max ?? condition.eq) });
	const fmt = (value: string) => formatMeasurement(value, facet.definition.unit, i18n.locale);

	// Handles snap to recorded values: the lowest still-included tick for the
	// lower bound, the highest still-included tick for the upper one.
	const minIndex = $derived.by(() => {
		if (bounds.min === null) return 0;
		const index = values.findIndex((value) => compareDecimals(value, bounds.min!) >= 0);
		return index === -1 ? values.length - 1 : index;
	});
	const maxIndex = $derived.by(() => {
		if (bounds.max === null) return values.length - 1;
		const index = values.findLastIndex((value) => compareDecimals(value, bounds.max!) <= 0);
		return index === -1 ? 0 : index;
	});

	const readout = $derived.by(() => {
		if (bounds.min !== null && bounds.max !== null) {
			return compareDecimals(bounds.min, bounds.max) === 0 ? fmt(bounds.min) : m.betweenValues(fmt(bounds.min), fmt(bounds.max));
		}
		if (bounds.min !== null) return m.fromValue(fmt(bounds.min));
		if (bounds.max !== null) return m.upToValue(fmt(bounds.max));
		return m.anyValue;
	});

	// Slider values are recorded-value indices, never decimal domain values.
	function slide(next: number[]) {
		if (next[0] !== minIndex) onbound('min', next[0] === 0 ? undefined : values[next[0]]);
		if (next[1] !== maxIndex) onbound('max', next[1] === values.length - 1 ? undefined : values[next[1]]);
	}
</script>

<p class="min-h-[1.55em] font-mono">{readout}</p>
{#if values.length > 1}
	<Slider type="multiple" class="min-h-11" min={0} max={values.length - 1} step={1}
		value={[minIndex, maxIndex]} disabled={!ready} onValueChange={slide}
		thumbProps={(index) => ({
			id: `${index === 0 ? 'min' : 'max'}-${facet.code}`,
			'aria-label': index === 0 ? m.min : m.max,
			'aria-valuetext': index === 0
				? bounds.min === null ? m.noLowerBound : fmt(values[minIndex])
				: bounds.max === null ? m.noUpperBound : fmt(values[maxIndex])
		})} />
	<div class="flex justify-between gap-3 text-sm text-muted-foreground"><span>{fmt(values[0])}</span><span>{fmt(values[values.length - 1])}</span></div>
{:else}
	<p class="text-sm text-muted-foreground">{fmt(values[0])}</p>
{/if}
