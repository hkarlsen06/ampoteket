import { expect, test } from 'bun:test';
import { parseEditableHelpContact, parseHelpContact, readHelpDirectory } from './help';
const config = { url: 'https://fixture.invalid', publishableKey: 'sb_publishable_fixture' };
const contact = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Volunteer', responsibility: null, email: 'helper@example.invalid', phone: null, contact_url: null, discord: null, display_order: '0' };

test('help traversal reads through capped pages and an empty terminal page', async () => {
	let requests = 0;
	const contacts = await readHelpDirectory(config, async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		expect(new Headers(init?.headers).has('Authorization')).toBe(false);
		expect(init?.cache).toBe('no-store');
		if (requests++ === 0) { expect(body.p_after_id).toBeUndefined(); return Response.json([contact]); }
		if (requests === 2) { expect(body.p_after_id).toBe(contact.id); return Response.json([{ ...contact, id: '22222222-2222-4222-8222-222222222222' }]); }
		return Response.json([]);
	});
	expect(contacts).toHaveLength(2); expect(requests).toBe(3);
});

test('directory failures and overlapping pages never become a complete empty directory', async () => {
	await expect(readHelpDirectory(config, async () => Response.json([contact]))).rejects.toThrow('cursor');
	await expect(readHelpDirectory(config, async () => Response.json({}, { status: 503 }))).rejects.toThrow();
	for (const contact_url of ['javascript:alert(1)', 'http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid:99999', 'https://example.invalid/\nfoo']) {
		expect(() => parseHelpContact({ ...contact, contact_url })).toThrow();
	}
});

test('directory parses exact revisions, rejects unsafe links and missing publication channels', () => {
	expect(parseEditableHelpContact({ ...contact, is_published: true, edit_revision: '9007199254740993' }).edit_revision).toBe('9007199254740993');
	expect(() => parseEditableHelpContact({ ...contact, email: null, is_published: true, edit_revision: '1' })).toThrow();
	expect(() => parseHelpContact({ ...contact, phone: '---' })).toThrow();
	expect(parseEditableHelpContact({ ...contact, email: null, discord: '.pizza_lover', is_published: true, edit_revision: '1' }).discord).toBe('.pizza_lover');
	for (const discord of ['Upper', 'a', 'two..dots', 'with space']) expect(() => parseHelpContact({ ...contact, discord })).toThrow();
});
