import { expect, test } from 'bun:test';
import { otherLanguageWords, translateName, untranslatedWords } from './name-translation';

test('drafts the other language name from known words and values', () => {
	expect(translateName('keramisk 4,7 pF', 'nb', 'en')).toBe('ceramic 4.7 pF');
	expect(translateName('Elektrolytisk 100 µF 25 V', 'nb', 'en')).toBe('Electrolytic 100 µF 25 V');
	expect(translateName('IRLZ44N N-kanal', 'nb', 'en')).toBe('IRLZ44N N-channel');
	expect(translateName('koblingsledninger hann–hann 20 cm', 'nb', 'en')).toBe('koblingsledninger male–male 20 cm');
	expect(translateName('carbon film 4.7 kΩ', 'en', 'nb')).toBe('karbonfilm 4,7 kΩ');
	expect(translateName('5 mm red', 'en', 'nb')).toBe('5 mm rød');
	expect(translateName('Gulvteppe', 'nb', 'en')).toBe('Gulvteppe');
	expect(translateName('Kameramodul', 'nb', 'en')).toBe('Camera module');
	expect(translateName('H-bro DC motordriver', 'nb', 'en')).toBe('H-bridge DC motor driver');
});

test('reports the words a draft left untranslated', () => {
	expect(untranslatedWords('Kameramodul', 'nb', 'en')).toEqual([]);
	expect(untranslatedWords('RFID modul', 'nb', 'en')).toEqual([]);
	expect(untranslatedWords('Gulvteppe', 'nb', 'en')).toEqual(['Gulvteppe']);
	expect(untranslatedWords('koblingsledninger hann–hann 20 cm', 'nb', 'en')).toEqual(['koblingsledninger']);
	expect(untranslatedWords('Temperatursensor DS18B20', 'nb', 'en')).toEqual(['Temperatursensor']);
	// Model numbers, acronyms, units, glossary words and shared words pass.
	expect(untranslatedWords('Arduino Nano ESP32 IRLZ44N N-kanal MOSFETs 4,7 kΩ 100 µF 20 mm', 'nb', 'en')).toEqual([]);
	expect(untranslatedWords('keramisk 4,7 pF', 'nb', 'en')).toEqual([]);
	expect(untranslatedWords('Servo motor SG90 with cable', 'en', 'nb')).toEqual([]);
	expect(untranslatedWords('Breadboard 830 holes', 'en', 'nb')).toEqual(['Breadboard']);
	expect(untranslatedWords('Gulvteppe gulvteppe', 'nb', 'en')).toEqual(['Gulvteppe']);
	expect(untranslatedWords('Gulvteppe', 'nb', 'nb')).toEqual([]);
});

test('finds words of the other language in a name', () => {
	expect(otherLanguageWords('Kameramodul', 'en')).toEqual(['Kameramodul']);
	expect(otherLanguageWords('RFID modul', 'en')).toEqual(['modul']);
	expect(otherLanguageWords('5 mm rød LED', 'en')).toEqual(['rød']);
	expect(otherLanguageWords('Blå og grønn', 'en')).toEqual(['Blå', 'og', 'grønn']);
	expect(otherLanguageWords('Trådløs mus', 'en')).toEqual(['Trådløs']);
	expect(otherLanguageWords('H-bridge DC motordriver', 'nb')).toEqual(['H-bridge']);
	expect(otherLanguageWords('Kabel med hann og hunn', 'nb')).toEqual([]);
	expect(otherLanguageWords('ceramic 4.7 pF', 'nb')).toEqual(['ceramic']);
	// Same in both languages, or a borrowing joined to a number.
	expect(otherLanguageWords('polyester 100 nF', 'nb')).toEqual([]);
	expect(otherLanguageWords('Stiftlist 2,54 mm 40-pin', 'nb')).toEqual([]);
	expect(otherLanguageWords('Pin header 2.54 mm 40-pin', 'en')).toEqual([]);
});
