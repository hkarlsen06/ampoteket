import { engineeringUnits, formatMeasurementText } from './format';
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
	['overflatemontert', 'surface-mount'], ['hullmontert', 'through-hole'], ['med', 'with'], ['uten', 'without'], ['og', 'and'],
	['modul', 'module'], ['kameramodul', 'camera module'], ['motordriver', 'motor driver'], ['h-bro', 'h-bridge']
];

// Words spelled the same in both languages, so a draft that keeps them is translated.
// Model numbers, acronyms (RFID, NPN, LEDs) and unit symbols are recognised without a list.
const sameInBoth = new Set(['arduino', 'raspberry', 'pi', 'nano', 'uno', 'mega', 'mini', 'micro', 'pro', 'motor', 'servo', 'sensor', 'display', 'film', 'jumper', 'dupont', 'bluetooth', 'wifi']);
const unitSymbols = new Set(['ohm', 'ohms', 'Ohm', 'Ohms', ...['Ω', 'F', 'H', 'V', 'A', 'W', 'Hz', 'm'].flatMap(unit => engineeringUnits(unit).map(choice => choice.symbol))]);

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsPattern = (words: string[]) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\p{L}\p{N}])`, 'giu');
const forms = (from: Locale) => glossary.map(([nb, en]) => from === 'nb' ? [nb, en] : [en, nb]);

export function translateName(text: string, from: Locale, to: Locale): string {
	if (from === to) return text;
	const pairs = forms(from);
	const lookup = new Map(pairs.map(([source, target]) => [source, target]));
	const translated = text.replace(wordsPattern(pairs.map(([source]) => source)), (word) => {
		const target = lookup.get(word.toLocaleLowerCase(from))!;
		return word[0] !== word[0].toLocaleLowerCase(from) ? target[0].toLocaleUpperCase(to) + target.slice(1) : target;
	});
	return formatMeasurementText(translated, to, from);
}

/** Words `translateName` would pass through unchanged although they probably need
 * translating: not in the glossary, not a model number, acronym or unit, and not a
 * word spelled the same in both languages. Each word once, in order. */
export function untranslatedWords(text: string, from: Locale, to: Locale): string[] {
	if (from === to) return [];
	const rest = text.replace(wordsPattern(forms(from).map(([source]) => source)), ' ');
	return unique([...rest.matchAll(/[\p{L}\p{N}]+/gu)].map(([word]) => word).filter(word => word.length > 1 && !/\p{N}/u.test(word)
		&& !/^\p{Lu}+s?$/u.test(word) && !unitSymbols.has(word) && !sameInBoth.has(word.toLocaleLowerCase(from))));
}

/** Words in a name written in `locale` that belong to the other language: the other
 * language's glossary words (only those spelled differently in this one), and in
 * English any word with æ, ø or å. A glossary word joined to a number ("40-pin") is a
 * common borrowing and is left out. */
export function otherLanguageWords(text: string, locale: Locale): string[] {
	const own = new Set(forms(locale).map(([word]) => word));
	const foreign = forms(locale).map(([, word]) => word).filter(word => !own.has(word));
	const found = [...text.matchAll(wordsPattern(foreign))].filter(match => !/\p{N}-$/u.test(text.slice(0, match.index))).map(([word]) => word);
	if (locale === 'en') found.push(...[...text.matchAll(/[\p{L}\p{N}]*[æøå][\p{L}\p{N}]*/giu)].map(([word]) => word));
	return unique(found);
}

function unique(words: string[]): string[] {
	const seen = new Set<string>();
	return words.filter(word => { const key = word.toLocaleLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
