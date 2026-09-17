/**
 * One-command local development: disposable workshop sample Supabase (API + Studio)
 * plus the Vite dev server, with a single Ctrl-C teardown.
 *
 *   bun run development                 # empty database + test admin, API :54329, Studio :54327
 *   bun run development -- --workshop   # photo-inspired inventory + test admin
 *   bun run development -- --count 30   # synthetic browser-test catalog
 *   bun run development -- --studio-port off  # no Studio, API only
 *   bun run development -- --sigkill      # kill whatever holds :54329/:54327, then start
 *
 * Extra arguments pass straight to scripts/seed-test.sh. The API and Studio
 * ports default to the pinned values the `dev.ampoteket.no` and
 * `api.dev.ampoteket.no` Caddy blocks target; pass explicit --api-port or
 * --studio-port to override them (the Caddy names then stop matching).
 *
 * It spawns seed-test.sh, reads the public settings and the private status
 * file of that owned seed, then starts `bun run dev` with its credentials.
 * Only the public settings reach the browser; the checkout secret stays in
 * the server environment. Real environment variables win over .env, so no
 * files are changed. Stopping removes only that seed and its synthetic data.
 *
 * Runs on Bun; checked by `bun run check:scripts`.
 */

const seedArgs = process.argv.slice(2);
if (!seedArgs.some(arg => ['--count', '--empty', '--workshop'].includes(arg))) seedArgs.push('--empty');
if (!seedArgs.includes('--api-port')) seedArgs.push('--api-port', '54329');
if (!seedArgs.includes('--studio-port')) seedArgs.push('--studio-port', '54327');

const seed = Bun.spawn(['bash', 'scripts/seed-test.sh', ...seedArgs], {
	stdout: 'pipe',
	stderr: 'inherit',
	env: process.env
});

const decoder = new TextDecoder();
let buffer = '';
let supabaseUrl = '';
let publishableKey = '';
let studioUrl = '';
let seedSettingsPath = '';
let dev: ReturnType<typeof Bun.spawn> | undefined;
let shuttingDown = false;

async function shutdown(code: number): Promise<never> {
	// The first caller decides the exit code; later callers wait it out.
	if (shuttingDown) await new Promise<never>(() => {});
	shuttingDown = true;
	dev?.kill();
	// Killing the seed script runs its EXIT trap, which removes only the
	// seed project and its synthetic data.
	seed.kill();
	await Promise.allSettled([dev?.exited, seed.exited]);
	process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		void shutdown(130);
	});
}

async function handleLine(line: string): Promise<void> {
	const ready = line.match(/^Seed settings: (\/tmp\/ampoteket-seed\.[A-Za-z0-9]{8}\/status\.json)$/);
	if (ready) {
		seedSettingsPath = ready[1];
		return;
	}
	const settings = line.match(
		/^PUBLIC_SUPABASE_URL='([^']+)' PUBLIC_SUPABASE_PUBLISHABLE_KEY='([A-Za-z0-9_.-]+)' bun run dev$/
	);
	if (settings && !dev) {
		supabaseUrl = settings[1];
		publishableKey = settings[2];
		if (!seedSettingsPath) throw new Error('The seed did not report its private settings file.');
		const status = await Bun.file(seedSettingsPath).json();
		const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
		if (status.API_URL !== supabaseUrl ||
			(status.PUBLISHABLE_KEY ?? status.ANON_KEY) !== publishableKey ||
			typeof secretKey !== 'string' || !secretKey) {
			throw new Error('Private settings do not match the owned seed.');
		}
		if (shuttingDown) return;
		dev = Bun.spawn(['bun', 'run', 'dev'], {
			stdout: 'inherit',
			stderr: 'inherit',
			env: {
				...process.env,
				// An explicit local HTTPS proxy is shared by browser and server reads.
				PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL ?? supabaseUrl,
				// Without an explicit proxy, Vite serves the API from the page's origin,
				// so phones and other machines on the network reach it too.
				...(process.env.PUBLIC_SUPABASE_URL ? {} : { SUPABASE_API_PROXY: supabaseUrl }),
				PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
				SUPABASE_SECRET_KEY: secretKey,
				CHECKOUT_ALLOWED_ORIGIN: process.env.CHECKOUT_ALLOWED_ORIGIN ?? 'https://dev.ampoteket.no'
			}
		});
		clearTimeout(timeout);
		void dev.exited.then((code) => {
			console.error(`Dev server exited (${code}); stopping the seed project.`);
			void shutdown(typeof code === 'number' ? code : 1);
		});
		console.log(`Dev site: http://localhost:5174; checkout origin: ${process.env.CHECKOUT_ALLOWED_ORIGIN ?? 'https://dev.ampoteket.no'}`);
		if (studioUrl) console.log(studioLine());
		return;
	}
	const studio = line.match(/^Studio: (\S+)$/);
	if (studio) {
		studioUrl = studio[1];
		if (dev) console.log(studioLine());
	}
}

/** The tailnet name only matches the pinned Studio port the Caddy block targets. */
function studioLine(): string {
	return studioUrl.endsWith(':54327')
		? `Studio: ${studioUrl} and https://api.dev.ampoteket.no`
		: `Studio: ${studioUrl}`;
}

const timeout = setTimeout(() => {
	console.error('Seed project did not report its settings in time; stopping.');
	void shutdown(1);
}, 10 * 60 * 1000);

try {
	for await (const chunk of seed.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		let end: number;
		while ((end = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			process.stdout.write(line + '\n');
			await handleLine(line);
		}
	}
} catch {
	// Do not expose credential-bearing status contents in an exception.
	console.error('Could not load the owned seed settings or start development; stopping.');
	await shutdown(1);
}
clearTimeout(timeout);
const seedCode = await seed.exited;
if (!dev) {
	// Handles --help/--check and startup failures: the seed already printed
	// what happened, so just mirror its exit status.
	process.exit(typeof seedCode === 'number' ? seedCode : 1);
}
if (!shuttingDown) void shutdown(0);
