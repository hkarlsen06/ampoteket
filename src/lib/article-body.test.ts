import { expect, test } from 'bun:test';
import { bodySlots, cursorSlot, parseBody, placeImage, removeImage, serializeBody, slotGroups, stepSlot, type BodyBlock } from './article-body';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const ids = new Set([a, b]);
const shape = (blocks: BodyBlock[]) => blocks.map(block => block.type === 'text' ? block.text : `<${block.id === a ? 'a' : 'b'}>`);

test('a stored body becomes text with images between, and back', () => {
	const stored = `One\n\n[image:${a}]\n\n[image:${b}]\n\nTwo\nlines`;
	const blocks = parseBody(stored, ids);
	// Every image has text on both sides, empty where there is none, so there is always room to type.
	expect(shape(blocks)).toEqual(['One', '<a>', '', '<b>', 'Two\nlines']);
	expect(serializeBody(blocks)).toBe(stored);
	expect(shape(parseBody(`[image:${a}]`, ids))).toEqual(['', '<a>', '']);
	// A marker for an image no longer in the list is dropped; one inside a sentence is text.
	expect(serializeBody(parseBody(`One\n\n[image:${b}]\n\nSee [image:${a}].`, new Set([a])))).toBe(`One\n\nSee [image:${a}].`);
});

test('an image can go between any two written lines, with blank lines as one place', () => {
	expect(slotGroups('A\nB\n\n\nC')).toEqual([{ at: 0, lines: [0] }, { at: 2, lines: [1] }, { at: 4, lines: [2, 3, 4] }, { at: 7, lines: [5] }]);
	expect(slotGroups('')).toEqual([{ at: 0, lines: [0, 1] }]);
	const blocks = parseBody('First line\nsecond line\n\nNext', ids);
	expect(shape(placeImage(blocks, { id: a }, { textKey: blocks[0].key, at: 11 }))).toEqual(['First line', '<a>', 'second line\n\nNext']);
	expect(shape(placeImage(blocks, { id: a }, { textKey: blocks[0].key, at: 0 }))).toEqual(['', '<a>', 'First line\nsecond line\n\nNext']);
});

test('moving an image keeps the text whole, and steps go one place at a time', () => {
	let blocks = parseBody(`One\n\n[image:${a}]\n\nTwo\nThree`, ids);
	const image = blocks[1] as Extract<BodyBlock, { type: 'image' }>;
	const text = blocks[2] as { key: string };
	blocks = placeImage(blocks, image, { textKey: text.key, at: 4 });
	expect(shape(blocks)).toEqual(['One\n\nTwo', '<a>', 'Three']);
	expect(blocks.find(block => block.type === 'image')?.key).toBe(image.key);
	const step = (direction: -1 | 1) => { const slot = stepSlot(blocks, image.key, direction); if (slot) blocks = placeImage(blocks, image, slot); return slot; };
	// An image stands between paragraphs, so the line it split stays two paragraphs when it leaves.
	step(-1); expect(shape(blocks)).toEqual(['One', '<a>', 'Two\n\nThree']);
	step(-1); expect(shape(blocks)).toEqual(['', '<a>', 'One\n\nTwo\n\nThree']);
	expect(step(-1)).toBeNull();
	step(1); step(1); step(1); expect(shape(blocks)).toEqual(['One\n\nTwo\n\nThree', '<a>', '']);
	expect(step(1)).toBeNull();
	// Past another image in one step.
	blocks = parseBody(`[image:${a}]\n\n[image:${b}]`, ids);
	const first = blocks[1] as Extract<BodyBlock, { type: 'image' }>;
	blocks = placeImage(blocks, first, stepSlot(blocks, first.key, 1)!);
	expect(shape(blocks)).toEqual(['', '<b>', '', '<a>', '']);
	expect(bodySlots(blocks)).toHaveLength(3);
	expect(shape(removeImage(blocks, blocks[1].key))).toEqual(['', '<a>', '']);
});

test('an image inserted at the cursor never splits a line', () => {
	const block = { key: 'k', text: 'First line\nsecond line' };
	expect(cursorSlot(block, 3)).toEqual({ textKey: 'k', at: 10 });
	expect(cursorSlot(block, 11)).toEqual({ textKey: 'k', at: 11 });
	expect(cursorSlot(block, 0)).toEqual({ textKey: 'k', at: 0 });
	expect(cursorSlot(block, 99)).toEqual({ textKey: 'k', at: 22 });
});
