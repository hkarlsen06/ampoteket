/**
 * The only production deploy: `bun run deploy:production`.
 *
 * Builds the committed tree, deploys `env.production` from wrangler.jsonc, then
 * checks that the live version carries exactly the reviewed vars and rate limits
 * and that /help can reach Supabase. Any failed check rolls back to the version
 * that was live before. A version uploaded without `--env production` lost every
 * var on 2026-10-01 and silently made the help page and staff login unavailable.
 */
import { unstable_readConfig } from 'wrangler';
import { nb } from '../src/lib/i18n/nb';

const origin = 'https://ampoteket.no';
const run = (args: string[], quiet = false) => {
	const result = Bun.spawnSync(args, { stdout: quiet ? 'pipe' : 'inherit', stderr: 'inherit' });
	if (!result.success) throw new Error(`failed: ${args.join(' ')}`);
	return quiet ? String(result.stdout) : '';
};
// Workers Builds splits wrangler arguments on whitespace (build 2252d081, 2026-10-02), so none may contain a space.
const wrangler = (...args: string[]) => run(['bunx', '--no-install', 'wrangler', ...args, '--env', 'production'], args.includes('--json'));
const liveVersion = () => {
	const deployments = JSON.parse(wrangler('deployments', 'list', '--json')) as { versions: { version_id: string; percentage: number }[] }[];
	const versions = deployments.at(-1)?.versions ?? [];
	if (versions.length !== 1 || versions[0].percentage !== 100) throw new Error('Production is not one version at 100%; resolve that by hand first.');
	return versions[0].version_id;
};

if (run(['git', 'status', '--porcelain'], true).trim()) throw new Error('Commit or stash changes first; production deploys only committed code.');
const config = unstable_readConfig({ env: 'production' });
if (config.name !== 'ampoteket') throw new Error(`Unexpected production Worker name ${config.name}`);

const previous = liveVersion();
console.log(`Live before deploy: ${previous}`);
run(['bun', 'run', 'build']);
wrangler('deploy', '--message', run(['git', 'rev-parse', '--short', 'HEAD'], true).trim());
const current = liveVersion();

const problems: string[] = [];
const bindings = (JSON.parse(wrangler('versions', 'view', current, '--json')) as { resources: { bindings: { name: string; type: string; text?: string }[] } }).resources.bindings;
for (const [name, value] of Object.entries(config.vars)) {
	const binding = bindings.find((b) => b.name === name);
	if (binding?.type !== 'plain_text' || binding.text !== value) problems.push(`var ${name} is ${binding ? JSON.stringify(binding.text) : 'missing'}, expected ${JSON.stringify(value)}`);
}
for (const limit of config.ratelimits ?? []) if (!bindings.some((b) => b.name === limit.name && b.type === 'ratelimit')) problems.push(`rate limit ${limit.name} is missing`);
for (const secret of ['SUPABASE_SECRET_KEY', 'RESEND_API_KEY']) if (!bindings.some((b) => b.name === secret && b.type === 'secret_text')) problems.push(`secret ${secret} is missing`);

// The help page renders its unavailable copy whenever the Worker cannot read Supabase.
const help = await fetch(`${origin}/help`, { headers: { 'cache-control': 'no-cache' } });
const page = await help.text();
if (!help.ok || page.includes(nb.help.unavailable)) problems.push(`${origin}/help cannot read the contact list (HTTP ${help.status})`);

if (problems.length) {
	console.error(`Deploy ${current} failed verification:\n  ${problems.join('\n  ')}\nRolling back to ${previous}.`);
	wrangler('rollback', previous, '--yes', '--message', `automatic-rollback-of-${current}`);
	process.exit(1);
}
console.log(`Verified ${current}: vars, rate limits, secrets and ${origin}/help.`);
