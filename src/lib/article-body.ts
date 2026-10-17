import { paragraphs } from './news';

// The article text as the editor shows it (docs/page-news.md §4): text blocks with the
// images placed between them. Stored, each image is a paragraph `[image:<id>]`
// (convex/news.ts). After `normalize` every image has a text block on both sides
// (possibly empty, so there is always somewhere to type) and no two text blocks touch.

export type BodyBlock = { key: string; type: 'text'; text: string } | { key: string; type: 'image'; id: string };
type TextBlock = Extract<BodyBlock, { type: 'text' }>;
/** A place an image can go: before character `at` of a text block. */
export type BodySlot = { textKey: string; at: number };

const marker = /^\[image:([^\]\n]*)\]$/;
let keys = 0;
const newKey = () => `block-${++keys}`;
const text = (value: string): TextBlock => ({ key: newKey(), type: 'text', text: value });
const join = (a: string, b: string) => [a.trimEnd(), b.trimStart()].filter(Boolean).join('\n\n');

export function normalize(blocks: BodyBlock[]): BodyBlock[] {
	const result: BodyBlock[] = [];
	for (const block of blocks) {
		const last = result.at(-1);
		if (block.type === 'text' && last?.type === 'text') result[result.length - 1] = { ...last, text: join(last.text, block.text) };
		else {
			if (block.type === 'image' && last?.type !== 'text') result.push(text(''));
			result.push(block);
		}
	}
	if (result.at(-1)?.type !== 'text') result.push(text(''));
	return result;
}

/** A stored body as blocks; a marker for an image that is not in the list is dropped. */
export function parseBody(body: string, imageIds: ReadonlySet<string>): BodyBlock[] {
	return normalize(paragraphs(body).flatMap((paragraph): BodyBlock[] => {
		const id = marker.exec(paragraph)?.[1];
		if (id === undefined) return [text(paragraph)];
		return imageIds.has(id) ? [{ key: newKey(), type: 'image', id }] : [];
	}));
}
export function serializeBody(blocks: BodyBlock[]): string {
	return blocks.map(block => block.type === 'image' ? `[image:${block.id}]` : block.text.replace(/\r\n?/g, '\n').trim()).filter(Boolean).join('\n\n');
}

/**
 * The distinct places inside a text where an image can go: its start, between any two
 * written lines (wrapping is not a line) and its end. Blank lines between paragraphs
 * are one place. `lines` are the line indexes whose top edge the place lies on, so the
 * editor can draw it; `lines.length` stands for the bottom edge.
 */
export function slotGroups(value: string): { at: number; lines: number[] }[] {
	const lines = value.split('\n');
	const groups = new Map<number, { at: number; lines: number[] }>();
	let start = 0;
	for (let line = 0; line <= lines.length; line++) {
		const at = line === lines.length ? value.length : start;
		const before = value.slice(0, at).trimEnd().length;
		const group = groups.get(before);
		if (group) group.lines.push(line); else groups.set(before, { at, lines: [line] });
		if (line < lines.length) start += lines[line].length + 1;
	}
	return [...groups.values()];
}

/** Every place an image can go, in reading order. */
export const bodySlots = (blocks: BodyBlock[]): BodySlot[] =>
	blocks.flatMap(block => block.type === 'text' ? slotGroups(block.text).map(group => ({ textKey: block.key, at: group.at })) : []);

/** Put an image (moved or new) at a place, splitting the text there. */
export function placeImage(blocks: BodyBlock[], image: { key?: string; id: string }, slot: BodySlot): BodyBlock[] {
	const rest = blocks.filter(block => block.key !== image.key);
	const index = rest.findIndex(block => block.key === slot.textKey && block.type === 'text');
	if (index < 0) return blocks;
	const target = rest[index] as TextBlock;
	return normalize([...rest.slice(0, index), { ...target, text: target.text.slice(0, slot.at).trimEnd() },
		{ key: image.key ?? newKey(), type: 'image', id: image.id }, text(target.text.slice(slot.at).trimStart()), ...rest.slice(index + 1)]);
}
export const removeImage = (blocks: BodyBlock[], key: string): BodyBlock[] => normalize(blocks.filter(block => block.key !== key));

/** The place one step before or after an image's own position, or null at either end. */
export function stepSlot(blocks: BodyBlock[], key: string, direction: -1 | 1): BodySlot | null {
	const index = blocks.findIndex(block => block.key === key);
	const before = blocks[index - 1];
	if (index < 0 || before?.type !== 'text') return null;
	const slots = bodySlots(blocks);
	// The image sits at the end of the text before it, which is also the start of the text after it.
	const here = slots.findLastIndex(slot => slot.textKey === before.key);
	return slots[direction < 0 ? here - 1 : here + 2] ?? null;
}

/** Where an image inserted at the cursor goes: before the line the cursor starts, otherwise after its line. */
export function cursorSlot(block: { key: string; text: string }, cursor: number): BodySlot {
	const position = Math.max(0, Math.min(cursor, block.text.length));
	if (position === 0 || block.text[position - 1] === '\n') return { textKey: block.key, at: position };
	const end = block.text.indexOf('\n', position);
	return { textKey: block.key, at: end < 0 ? block.text.length : end };
}
