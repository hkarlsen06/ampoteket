import { formatMeasurementText } from './format';
import type { Locale } from './i18n';

// A first draft of the other language's product name, never a final one: staff
// edit the result. Words missing here (model numbers, brands) pass through unchanged,
// and electrical values switch decimal separator ("4,7 pF" ↔ "4.7 pF").
// Add a pair when staff keep correcting the same word. Norwegian first.
const glossary: [nb: string, en: string][] = [
	['keramisk', 'ceramic'], ['elektrolytisk', 'electrolytic'], ['elektrolytt', 'electrolytic'], ['tantal', 'tantalum'],
	['polyester', 'polyester'], ['karbonfilm', 'carbon film'], ['metallfilm', 'metal film'], ['trådviklet', 'wirewound'],
	['likeretter', 'rectifier'], ['kanal', 'channel'], ['effekt', 'power'], ['lav', 'low'], ['høy', 'high'],
	['rød', 'red'], ['grønn', 'green'], ['blå', 'blue'], ['gul', 'yellow'], ['hvit', 'white'], ['varmhvit', 'warm white'],
	['kaldhvit', 'cool white'], ['oransje', 'orange'], ['lilla', 'purple'], ['svart', 'black'], ['infrarød', 'infrared'],
	['klar', 'clear'], ['blinkende', 'flashing'], ['hann', 'male'], ['hunn', 'female'], ['ledninger', 'wires'], ['ledning', 'wire'],
	['kabel', 'cable'], ['stiftlist', 'pin header'], ['hull', 'holes'], ['pinner', 'pins'], ['pinne', 'pin'],
	['bryter', 'switch'], ['trykknapp', 'push button'], ['knapp', 'button'], ['vinklet', 'angled'], ['rett', 'straight'],
	['overflatemontert', 'surface-mount'], ['hullmontert', 'through-hole'], ['med', 'with'], ['uten', 'without'], ['og', 'and']
];

export function translateName(text: string, from: Locale, to: Locale): string {
	if (from === to) return text;
	const pairs = glossary.map(([nb, en]) => from === 'nb' ? [nb, en] : [en, nb]).sort((a, b) => b[0].length - a[0].length);
	const lookup = new Map(pairs.map(([source, target]) => [source, target]));
	const words = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${pairs.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\p{L}\p{N}])`, 'giu');
	const translated = text.replace(words, (word) => {
		const target = lookup.get(word.toLocaleLowerCase(from))!;
		return word[0] !== word[0].toLocaleLowerCase(from) ? target[0].toLocaleUpperCase(to) + target.slice(1) : target;
	});
	return formatMeasurementText(translated, to, from);
}
