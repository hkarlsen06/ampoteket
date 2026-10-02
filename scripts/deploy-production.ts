/** The only production deploy: wait for this commit's CI, publish, verify, roll back on failure. */
import { unstable_readConfig } from 'wrangler';
import { nb } from '../src/lib/i18n/nb';
import type { Fetcher } from '../src/lib/api';

const origin = 'https://ampoteket.no';
const run = (args: string[], quiet = false) => {
	const result = Bun.spawnSync(args, { stdout: quiet ? 'pipe' : 'inherit', stderr: 'inherit' });
	if (!result.success) throw new Error(`failed: ${args.join(' ')}`);
	return quiet ? String(result.stdout) : '';
};

/** Public GitHub reads need no build secret. Any API error fails before upload. */
export async function requireValidation(sha: string, fetcher: Fetcher = fetch, pause = Bun.sleep) {
	const url = `https://api.github.com/repos/hkarlsen06/ampoteket/actions/workflows/database.yml/runs?head_sha=${sha}&event=push&per_page=10`;
	for (let attempt = 0; attempt < 20; attempt++) {
		const response = await fetcher(url, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ampoteket-deploy' },
			cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000)
		});
		if (!response.ok) throw new Error(`Cannot verify GitHub validation (HTTP ${response.status}); nothing deployed.`);
		const result = await response.json() as { workflow_runs: { head_sha: string; event: string; status: string; conclusion: string | null; html_url: string }[] };
		const validation = result.workflow_runs.find((entry) => entry.head_sha === sha && entry.event === 'push');
		if (validation?.status === 'completed') {
			if (validation.conclusion !== 'success') throw new Error(`Validation ${validation.conclusion}: ${validation.html_url}; nothing deployed.`);
			console.log(`Validation passed for ${sha}: ${validation.html_url}`);
			return;
		}
		console.log(`Waiting for Validation on ${sha} (${validation?.status ?? 'not started'})…`);
		if (attempt < 19) await pause(45000);
	}
	throw new Error('Validation did not finish within 20 checks; retry after CI passes. Nothing deployed.');
}

// Injectable process/network boundaries let tests exercise failures without contacting production.
export async function deployProduction(command = run, fetcher: Fetcher = fetch, pause = Bun.sleep) {
	// Workers Builds splits wrangler arguments on whitespace, so none may contain a space.
	const wrangler = (...args: string[]) => command(['bunx', '--no-install', 'wrangler', ...args, '--env', 'production'], args.includes('--json'));
	const liveVersion = () => {
		const deployments = JSON.parse(wrangler('deployments', 'list', '--json')) as { versions: { version_id: string; percentage: number }[] }[];
		const versions = deployments.at(-1)?.versions ?? [];
		if (versions.length !== 1 || versions[0].percentage !== 100) throw new Error('Production is not one version at 100%; resolve that by hand first.');
		return versions[0].version_id;
	};

	const committedRevision = () => {
		if (command(['git', 'status', '--porcelain'], true).trim()) throw new Error('Commit changes first; production deploys only committed code.');
		const revision = command(['git', 'rev-parse', 'HEAD'], true).trim();
		if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid release commit.');
		return revision;
	};
	const sha = committedRevision();
	const config = unstable_readConfig({ env: 'production' });
	if (config.name !== 'ampoteket') throw new Error(`Unexpected production Worker name ${config.name}`);
	await requireValidation(sha, fetcher, pause);
	if (committedRevision() !== sha) throw new Error('Release commit changed while waiting for CI; nothing deployed.');
	command(['bun', 'run', 'build']);
	if (committedRevision() !== sha) throw new Error('Release commit changed while building; nothing deployed.');
	const previous = liveVersion();
	console.log(`Live before deploy: ${previous}`);
	try {
		wrangler('deploy', '--message', sha);
		const current = liveVersion();
		if (current === previous) throw new Error('Deploy did not activate a new version.');
		const problems: string[] = [];
		const bindings = (JSON.parse(wrangler('versions', 'view', current, '--json')) as { resources: { bindings: { name: string; type: string; text?: string; namespace_id?: string; simple?: { limit: number; period: number } }[] } }).resources.bindings;
		for (const [name, value] of Object.entries(config.vars)) {
			const binding = bindings.find((b) => b.name === name);
			if (binding?.type !== 'plain_text' || binding.text !== value) problems.push(`var ${name} does not match the reviewed value`);
		}
		for (const limit of config.ratelimits ?? []) {
			const binding = bindings.find((b) => b.name === limit.name);
			if (binding?.type !== 'ratelimit' || binding.namespace_id !== limit.namespace_id
				|| binding.simple?.limit !== limit.simple.limit || binding.simple?.period !== limit.simple.period) problems.push(`rate limit ${limit.name} does not match`);
		}
		for (const secret of ['SUPABASE_SECRET_KEY', 'RESEND_API_KEY']) if (!bindings.some((b) => b.name === secret && b.type === 'secret_text')) problems.push(`secret ${secret} is missing`);

		const options = { redirect: 'manual' as const, signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } };
		const help = await fetcher(`${origin}/help`, options);
		const page = await help.text();
		if (!help.ok || page.includes(nb.help.unavailable)) problems.push(`/help cannot read the contact list (HTTP ${help.status})`);
		if (help.headers.get('Strict-Transport-Security') !== 'max-age=31536000') problems.push('HTTPS response lacks the reviewed HSTS policy');
		const http = await fetcher('http://ampoteket.no/admin/login', { ...options, signal: AbortSignal.timeout(15000) });
		await http.body?.cancel();
		const location = http.headers.get('Location');
		if (![301, 308].includes(http.status) || location !== `${origin}/admin/login`) problems.push(`HTTP login does not redirect to HTTPS (HTTP ${http.status}, Location ${JSON.stringify(location)}, CF-Ray ${http.headers.get('CF-Ray') ?? 'unavailable'})`);
		if (problems.length) throw new Error(problems.join('; '));
		console.log(`Verified ${current}: vars, rate limits, secrets, HTTPS and /help.`);
	} catch (error) {
		console.error(`Post-deploy verification failed. Rolling back to ${previous}.`, error instanceof Error ? error.message : error);
		try { wrangler('rollback', previous, '--yes', '--message', `automatic-rollback-of-${sha}`); }
		catch (rollbackError) { throw new AggregateError([error, rollbackError], `Verification and rollback failed; inspect production. Previous version: ${previous}`, { cause: rollbackError }); }
		throw error;
	}
}

if (import.meta.main) await deployProduction();
