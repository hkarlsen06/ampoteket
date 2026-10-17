/**
 * Give a Convex deployment its Convex Auth signing keys (docs/runbook-cutover.md §1).
 * Generates a fresh key pair and sets JWT_PRIVATE_KEY and JWKS on the deployment
 * through the Convex CLI; nothing is printed or stored. The deployment comes from
 * CONVEX_DEPLOY_KEY (or the CLI's usual configuration).
 *
 *   CONVEX_DEPLOY_KEY='prod:…' bun scripts/convex-cutover/auth-keys.ts
 *   CONVEX_DEPLOY_KEY='prod:…' bun scripts/convex-cutover/auth-keys.ts --replace
 *
 * Existing keys are kept unless --replace is given: new keys sign every admin out.
 */
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

const replace = process.argv.includes('--replace');
if (process.argv.slice(2).some((arg) => arg !== '--replace')) {
	console.error('Usage: CONVEX_DEPLOY_KEY=… bun scripts/convex-cutover/auth-keys.ts [--replace]');
	process.exit(1);
}

async function convex(...args: string[]): Promise<{ code: number; out: string }> {
	const run = Bun.spawn(['bunx', 'convex', ...args], { stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
	return { code, out: `${out}\n${err}` };
}

const existing = await convex('env', 'get', 'JWT_PRIVATE_KEY');
if (existing.code === 0 && existing.out.includes('BEGIN PRIVATE KEY') && !replace) {
	console.log('This deployment already has Auth keys; nothing changed. Use --replace to rotate them (signs every admin out).');
	process.exit(0);
}

const keys = await generateKeyPair('RS256', { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, ' ');
const jwks = JSON.stringify({ keys: [{ use: 'sig', ...(await exportJWK(keys.publicKey)) }] });
for (const [name, value] of [['JWT_PRIVATE_KEY', privateKey], ['JWKS', jwks]]) {
	// `--` keeps the PEM's leading dashes from being read as an option.
	const result = await convex('env', 'set', name, '--', value);
	if (result.code !== 0) {
		console.error(`Could not set ${name}; check CONVEX_DEPLOY_KEY. Convex said:\n${result.out.replaceAll(value, '[value]').trim()}`);
		process.exit(1);
	}
}
console.log('Set JWT_PRIVATE_KEY and JWKS on the deployment.');
