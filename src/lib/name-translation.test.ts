import { expect, test } from 'bun:test';
import { translateName } from './name-translation';

test('drafts the other language name from known words and values', () => {
	expect(translateName('keramisk 4,7 pF', 'nb', 'en')).toBe('ceramic 4.7 pF');
	expect(translateName('Elektrolytisk 100 µF 25 V', 'nb', 'en')).toBe('Electrolytic 100 µF 25 V');
	expect(translateName('IRLZ44N N-kanal', 'nb', 'en')).toBe('IRLZ44N N-channel');
	expect(translateName('koblingsledninger hann–hann 20 cm', 'nb', 'en')).toBe('koblingsledninger male–male 20 cm');
	expect(translateName('carbon film 4.7 kΩ', 'en', 'nb')).toBe('karbonfilm 4,7 kΩ');
	expect(translateName('5 mm red', 'en', 'nb')).toBe('5 mm rød');
	expect(translateName('Gulvteppe', 'nb', 'en')).toBe('Gulvteppe');
});
