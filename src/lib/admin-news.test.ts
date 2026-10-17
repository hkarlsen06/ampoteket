import { expect, test } from 'bun:test';
import { insertParagraph, numberMarkers, placedNumbers, storeMarkers } from './admin-news';

const a = { id: '11111111-1111-4111-8111-111111111111', alt: 'A' }, b = { id: '22222222-2222-4222-8222-222222222222', alt: 'B' };

test('markers are numbered for the editor and stored by id, as paragraphs of their own', () => {
	const stored = `Intro.\n\n[image:${b.id}]\n\nEnd.`;
	expect(numberMarkers(stored, [a, b], 'bilde')).toBe('Intro.\n\n[bilde 2]\n\nEnd.');
	// Reordering the list renumbers; an image taken out of the list leaves the text.
	expect(numberMarkers(stored, [b, a], 'image')).toBe('Intro.\n\n[image 1]\n\nEnd.');
	expect(numberMarkers(stored, [a], 'bilde')).toBe('Intro.\n\nEnd.');
	// Either word, any case, on a line of its own, even without blank lines around it.
	expect(storeMarkers('Intro.\n[Bilde 2]\nEnd.\n\n  [image 1] ', [a, b])).toBe(`Intro.\n\n[image:${b.id}]\n\nEnd.\n\n[image:${a.id}]`);
	expect(storeMarkers('Se [bilde 1] her.', [a])).toBe('Se [bilde 1] her.');
	expect(storeMarkers('[bilde 3]', [a, b])).toBeNull();
	expect(placedNumbers('[bilde 2]\n\nSe [bilde 1] her.\n[IMAGE 3]')).toEqual(new Set([2, 3]));
});

test('an inserted image goes before the line the cursor starts, otherwise after its line', () => {
	const body = 'First line\nsecond line\n\nNext paragraph';
	expect(insertParagraph(body, 3, '[bilde 1]')).toEqual({ body: 'First line\n\n[bilde 1]\n\nsecond line\n\nNext paragraph', cursor: 21 });
	expect(insertParagraph(body, 11, '[bilde 1]').body).toBe('First line\n\n[bilde 1]\n\nsecond line\n\nNext paragraph');
	expect(insertParagraph(body, 0, '[bilde 1]').body).toBe('[bilde 1]\n\nFirst line\nsecond line\n\nNext paragraph');
	expect(insertParagraph(body, body.length, '[bilde 1]').body).toBe(`${body}\n\n[bilde 1]`);
	expect(insertParagraph('', 0, '[bilde 1]')).toEqual({ body: '[bilde 1]', cursor: 9 });
});
