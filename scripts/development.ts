/**
 * One-command local development: a disposable local Convex backend (functions
 * redeploy on save), seeded data, and the Vite dev server, with one Ctrl-C teardown.
 *
 *   bun run development                 # the wall and a test admin, no products
 *   bun run development -- --workshop   # photo-inspired inventory + test admin
 *   bun run development -- --count 30   # synthetic browser-test catalog (30–10000)
 *
 * Ports are pinned: the dev site on 5174 (dev.ampoteket.no) and the backend on
 * 54329. A port already in use is reported, never taken over: it may be the
 * owner's or another session's server. The browser reaches the backend through
 * the dev server at /convex (vite.config.ts), so dev.ampoteket.no and phones work.
 * Everything lives in a fresh /tmp directory that is deleted on exit; no hosted
 * deployment, .env or .env.local is read.
 *
 * Runs on Bun; checked by `bun run check:scripts`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { DEFAULT_SEED_COUNT, seedDemoData } from './seed-test-data';
import { WORKSHOP_PARTS } from './seed-workshop-data';

const SITE_PORT = 5174, BACKEND_PORT = 54329, BACKEND_SITE_PORT = 54330;
const args = process.argv.slice(2);
let profile: 'empty' | 'workshop' | 'synthetic' = 'empty', count = DEFAULT_SEED_COUNT;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--workshop' || args[i] === '--empty') profile = args[i].slice(2) as 'workshop' | 'empty';
	else if (args[i] === '--count' && /^\d+$/.test(args[i + 1] ?? '')) { profile = 'synthetic'; count = Number(args[++i]); }
	else throw new Error('Usage: bun run development [-- --empty | --workshop | --count 30..10000]');
}

const free = (port: number) => new Promise<boolean>((resolve) => {
	const server = createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)));
	server.listen(port, '127.0.0.1');
});
for (const port of [SITE_PORT, BACKEND_PORT, BACKEND_SITE_PORT]) {
	if (!await free(port)) throw new Error(`Port ${port} is in use (another session's or the owner's server?). Stop it yourself first; this script never kills it.`);
}
const binary = (await Array.fromAsync(new Bun.Glob(`${process.env.HOME}/.cache/convex/binaries/*/convex-local-backend`).scan({ absolute: true }))).sort().at(-1);
if (!binary) throw new Error('No Convex backend binary cached; run: CONVEX_AGENT_MODE=anonymous bunx convex dev --once');

const directory = await mkdtemp('/tmp/ampoteket-dev.');
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping: Promise<void> | undefined;
/** Every exit path waits for the same teardown, so the temporary backend is always deleted. */
async function stop(code: number): Promise<never> {
	stopping ??= (async () => {
		for (const child of [...children].reverse()) child.kill();
		await Promise.allSettled(children.map((child) => child.exited));
		await rm(directory, { recursive: true, force: true });
	})();
	await stopping;
	process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop(130));

try {
	const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
	const name = 'ampoteket-dev', secret = hex();
	const adminKey = (await new Response(Bun.spawn([binary, 'keygen', 'admin-key', '--instance-name', name, '--instance-secret', secret]).stdout).text()).trim();
	const backend = `http://127.0.0.1:${BACKEND_PORT}`;
	children.push(Bun.spawn([binary, '--port', String(BACKEND_PORT), '--site-proxy-port', String(BACKEND_SITE_PORT), '--instance-name', name,
		'--instance-secret', secret, '--local-storage', `${directory}/storage`, `${directory}/convex.sqlite3`], { stdout: Bun.file(`${directory}/backend.log`), stderr: 'inherit' }));
	for (let attempt = 0; ; attempt++) {
		try { if ((await fetch(`${backend}/version`)).ok) break; } catch { /* starting */ }
		if (attempt > 100) throw new Error('The local Convex backend did not start.');
		await Bun.sleep(200);
	}
	const envFile = `${directory}/backend.env`;
	await writeFile(envFile, `CONVEX_SELF_HOSTED_URL=${backend}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
	const convex = async (...command: string[]) => {
		const run = Bun.spawn(['bunx', 'convex', ...command.slice(0, 2), '--env-file', envFile, ...command.slice(2)], { stdout: 'ignore', stderr: 'inherit' });
		if (await run.exited !== 0) throw new Error(`convex ${command.slice(0, 2).join(' ')} failed`);
	};
	const keys = await generateKeyPair('RS256', { extractable: true });
	const serverKey = hex(), origin = process.env.CHECKOUT_ALLOWED_ORIGIN ?? 'https://dev.ampoteket.no';
	await convex('env', 'set', 'JWT_PRIVATE_KEY', '--', (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, ' '));
	await convex('env', 'set', 'JWKS', JSON.stringify({ keys: [{ use: 'sig', ...(await exportJWK(keys.publicKey)) }] }));
	for (const [key, value] of [['SITE_URL', origin], ['CHECKOUT_SERVER_KEY', serverKey], ['ALLOW_TEST_FIXTURES', 'true']]) await convex('env', 'set', key, value);
	console.log('Deploying functions to the local backend…');
	await convex('deploy', '--yes');
	// Watch convex/ and redeploy on save.
	children.push(Bun.spawn(['bunx', 'convex', 'dev', '--env-file', envFile], { stdout: 'inherit', stderr: 'inherit' }));

	const admin = new ConvexHttpClient(backend, { logger: false });
	(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
	const run = (kind: 'mutation', fn: string, fnArgs: Record<string, unknown>) => admin[kind](makeFunctionReference<'mutation'>(fn) as never, fnArgs as never);
	await run('mutation', 'seed:base', {});
	const password = `${hex().slice(0, 16)}-Aa7`;
	await run('mutation', 'seed:staff', { email: 'admin@example.test', password, displayName: 'Test admin' });
	if (profile === 'synthetic') await seedDemoData(run, count);
	if (profile === 'workshop') await seedDemoData(run, WORKSHOP_PARTS.length, { parts: WORKSHOP_PARTS,
		description: 'Unofficial development sample inspired by workshop photos. Stock and placement are illustrative.' });

	const dev = Bun.spawn(['bun', '--bun', 'run', 'dev'], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env,
		CONVEX_DEV_PROXY: backend, PUBLIC_CONVEX_URL: backend, CHECKOUT_SERVER_KEY: serverKey,
		CHECKOUT_ALLOWED_ORIGIN: origin, SALES_OPEN: process.env.SALES_OPEN ?? 'true' } });
	children.push(dev);
	console.log(`Dev site: http://localhost:${SITE_PORT} and ${origin}`);
	console.log(`Admin: admin@example.test / ${password} (this run only)`);
	void dev.exited.then((code) => { console.error(`Dev server exited (${code}); stopping.`); void stop(typeof code === 'number' ? code : 1); });
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	await stop(1);
}
