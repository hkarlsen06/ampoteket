import { expect, test } from 'bun:test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { ConvexCaller } from './convex';
import { parseEditableHelpContact, parseHelpContact, readHelpDirectory } from './help';
const contact = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Volunteer', responsibility: null, email: 'helper@example.invalid', phone: null, contact_url: null, discord: null, display_order: 0 };
function stub(answer: () => unknown) {
	const calls: { name: string; args: unknown }[] = [];
	const unexpected = async () => { throw new Error('Unexpected write'); };
	const client = { query: async (fn: FunctionReference<'query'>, args: unknown) => {
		calls.push({ name: getFunctionName(fn), args }); return answer();
	}, mutation: unexpected, action: unexpected } as unknown as ConvexCaller;
	return { client, calls };
}

test('the directory is one public query, read in display order', async () => {
	const second = { ...contact, id: '22222222-2222-4222-8222-222222222222', display_order: 1 };
	const { client, calls } = stub(() => [contact, second]);
	expect((await readHelpDirectory(client)).map((entry) => entry.id)).toEqual([contact.id, second.id]);
	expect(calls).toEqual([{ name: 'catalog:helpDirectory', args: {} }]);
});

test('directory failures, repeats and unreachable entries never become a usable directory', async () => {
	await expect(readHelpDirectory(stub(() => [contact, contact]).client)).rejects.toThrow();
	await expect(readHelpDirectory(stub(() => [{ ...contact, email: null }]).client)).rejects.toThrow();
	await expect(readHelpDirectory(stub(() => { throw new Error('Unavailable'); }).client)).rejects.toThrow('Unavailable');
	for (const contact_url of ['javascript:alert(1)', 'http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid:99999', 'https://example.invalid/\nfoo']) {
		expect(() => parseHelpContact({ ...contact, contact_url })).toThrow();
	}
	for (const display_order of ['0', -1, 1.5]) expect(() => parseHelpContact({ ...contact, display_order })).toThrow();
});

test('directory parses exact revisions, rejects unsafe links and missing publication channels', () => {
	expect(parseEditableHelpContact({ ...contact, is_published: true, edit_revision: '9007199254740993' }).edit_revision).toBe('9007199254740993');
	expect(() => parseEditableHelpContact({ ...contact, email: null, is_published: true, edit_revision: '1' })).toThrow();
	expect(() => parseHelpContact({ ...contact, phone: '---' })).toThrow();
	expect(parseEditableHelpContact({ ...contact, email: null, discord: '.pizza_lover', is_published: true, edit_revision: '1' }).discord).toBe('.pizza_lover');
	for (const discord of ['Upper', 'a', 'two..dots', 'with space']) expect(() => parseHelpContact({ ...contact, discord })).toThrow();
});
