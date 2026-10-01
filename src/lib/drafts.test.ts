import { expect, test } from 'bun:test';
import { draftFields, readDraft, writeDraft } from './drafts';
import { memory } from './test-storage';

test('drafts are per user and removed with null', () => {
	const storage = memory();
	writeDraft('a', 'order', { supplier: 'Elfa' }, storage);
	expect(readDraft('a', 'order', storage)).toEqual({ supplier: 'Elfa' });
	expect(readDraft('b', 'order', storage)).toBeNull();
	expect(readDraft(undefined, 'order', storage)).toBeNull();
	writeDraft('a', 'order', null, storage);
	expect(readDraft('a', 'order', storage)).toBeNull();
});

test('draftFields keeps only fields typed like the shape', () => {
	const shape = { name: '', note: null as string | null, active: false };
	expect(draftFields(shape, { name: 'LED', note: 'shelf', active: true, extra: 1 })).toEqual({ name: 'LED', note: 'shelf', active: true });
	expect(draftFields(shape, { name: null, note: 3, active: 'yes' })).toEqual({});
	expect(draftFields(shape, { note: null })).toEqual({ note: null });
	expect(draftFields(shape, 'broken')).toEqual({});
});
