// Every write to an audited table goes through convex/lib/audit.ts, which records
// the before/after image (datamodell.md §2). A static check: a new direct write
// fails here until it is reviewed and listed.
import { expect, test } from 'bun:test';
import { AUDITED } from '../convex/lib/audit';

/** Files that write audited tables on purpose without an audit image: the helper, the import, seeds and test fixtures. */
const exempt = new Set(['convex/lib/audit.ts', 'convex/migration.ts', 'convex/seed.ts', 'convex/fixtures.ts']);
/** Reviewed direct patches and deletes per file; each targets a table that is not audited. */
const reviewed: Record<string, number> = {
	'convex/passwords.ts': 4, // password_tokens, authAccounts, users
	'convex/retention.ts': 1, // checkout_contacts (audited as CONTACT_CLEARED)
	'convex/checkout.ts': 1, // checkout_contacts (audited as CONTACT_CLEARED)
	'convex/members.ts': 2, // users.auth_user_id (invitation and maintainer grant)
	'convex/lib/commands.ts': 1, // command_requests.result
	'convex/lib/sequence.ts': 1, // counters
	'convex/lib/rateLimit.ts': 2, // rate_limits
	'convex/lib/inventory.ts': 2, // stock_levels
	'convex/news.ts': 1 // news_image_uses
};

test('audited tables are written only through the audit helper', async () => {
	const audited = new Set<string>(AUDITED);
	const directInserts: string[] = [], patches: Record<string, number> = {};
	for await (const file of new Bun.Glob('convex/**/*.ts').scan()) {
		if (file.startsWith('convex/_generated/') || exempt.has(file)) continue;
		const source = await Bun.file(file).text();
		for (const [, table] of source.matchAll(/ctx\.db\.insert\(\s*'(\w+)'/g)) if (audited.has(table)) directInserts.push(`${file}: ${table}`);
		const count = [...source.matchAll(/ctx\.db\.(patch|replace|delete)\(/g)].length;
		if (count) patches[file] = count;
	}
	expect(directInserts).toEqual([]);
	expect(patches).toEqual(reviewed);
});
