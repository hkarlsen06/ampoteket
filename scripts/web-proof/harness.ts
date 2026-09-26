import { expect, type BrowserContext, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';

/**
 * Exact label text for getByLabel(). Playwright reads the label's full text, including
 * the aria-hidden asterisk that Field.Label adds to required fields, so allow it here.
 */
export function fieldLabel(text: string): RegExp {
	return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`);
}

export async function signIn(page: Page, origin: string, email: string, password: string) {
	await page.goto(`${origin}/en/admin/login`);
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
	await page.getByLabel(fieldLabel('Email address')).fill(email);
	await page.getByLabel(fieldLabel('Password')).fill(password);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function fits(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

export async function post(page: Page, path: string, body: unknown = {}) {
	return page.evaluate(async ({ path, body }) => {
		const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		return { status: response.status, cache: response.headers.get('Cache-Control'), body: await response.json() };
	}, { path, body });
}

/** Login pages are skipped for the accessibility tree because it includes filled field values. */
export async function captureFailure(page: Page, artifacts: string, name: string, root = 'main') {
	await page.screenshot({ path: `${artifacts}/failure-${name}.png`, fullPage: true }).catch(() => {});
	if (!page.url().includes('/login')) await writeFile(`${artifacts}/failure-${name}.txt`, await page.locator(root).ariaSnapshot().catch(() => 'Unavailable'));
}

/** Services and credentials belong to the disposable project created by test-web.sh. */
export async function proofEnvironment() {
	const [directory, port, inspectorPort] = process.argv.slice(2);
	assert.match(directory ?? '', /^\/tmp\/ampoteket-web\.[A-Za-z0-9]{8}$/);
	for (const value of [port, inspectorPort]) {
		assert.match(value ?? '', /^\d+$/);
		assert.ok(Number(value) > 0 && Number(value) <= 65535, 'Use scripts/test-web.sh');
	}
	const origin = `https://localhost:${port}`;
	const status = await Bun.file(`${directory}/status.json`).json();
	const api = new URL(status.API_URL);
	const database = new URL(status.DB_URL);
	assert.ok(api.protocol === 'http:' && api.hostname === '127.0.0.1'
		&& database.protocol === 'postgresql:' && database.hostname === '127.0.0.1', 'Proof refuses nonlocal services');
	const publicKey: string = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
	const serviceKey: string = status.SERVICE_ROLE_KEY;
	const anonKey: string = status.ANON_KEY;
	const gatewayKey: string = status.SECRET_KEY ?? serviceKey;
	for (const key of [publicKey, anonKey, serviceKey, gatewayKey]) assert.ok(typeof key === 'string' && key.length > 0);
	const password = crypto.randomUUID() + '!Aa7';
	const secrets = [publicKey, serviceKey, gatewayKey, password, decodeURIComponent(database.password)].filter(Boolean);
	const safe = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
		.replace(/[a-f0-9]{64}/g, '[redacted]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]');
	const ca = await Bun.file(`${directory}/ca.pem`).text();
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) if (key.startsWith('PG')) delete environment[key];
	async function sql(input: string, variables: string[] = []): Promise<string> {
		const command = Bun.spawn(['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...variables], {
			stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe',
			env: { ...environment, PGHOST: database.hostname, PGPORT: database.port, PGDATABASE: database.pathname.slice(1),
				PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password), PGSSLMODE: 'disable' }
		});
		const [code, output, error] = await Promise.all([command.exited, new Response(command.stdout).text(), new Response(command.stderr).text()]);
		if (code) throw new Error(`Disposable fixture failed: ${safe(error)}`);
		return output.trim();
	}
	async function createUser(email: string) {
		const response = await fetch(`${api.origin}/auth/v1/admin/users`, {
			method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password, email_confirm: true })
		});
		assert.ok(response.ok, 'Temporary Auth identity created');
		const { id } = await response.json() as { id: string };
		assert.match(id, /^[a-f0-9-]{36}$/);
		return id;
	}
	async function startWorker(getContext: () => BrowserContext | undefined, config?: Record<string, unknown>) {
		await writeFile(`${directory}/wrangler-proof.json`, JSON.stringify(config ?? {
			name: 'ampoteket-site-proof', main: `${directory}/site/cloudflare/_worker.js`,
			compatibility_date: '2026-09-18', compatibility_flags: ['nodejs_als'], workers_dev: false,
			assets: { directory: `${directory}/site/cloudflare`, binding: 'ASSETS' },
			vars: { PUBLIC_SUPABASE_URL: api.origin, PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
				SUPABASE_SECRET_KEY: gatewayKey, CHECKOUT_ALLOWED_ORIGIN: origin },
			ratelimits: [
				{ name: 'CHECKOUT_SESSION_LIMIT', namespace_id: '4732201', simple: { limit: 20, period: 60 } },
				{ name: 'CHECKOUT_OPERATION_LIMIT', namespace_id: '4732202', simple: { limit: 120, period: 60 } }
			]
		}));
		// Never read the repository's .env/.dev.vars or hosted Cloudflare credentials.
		await writeFile(`${directory}/empty.env`, '');
		function launch() {
			return Bun.spawn(['bun', 'x', '--no-install', 'wrangler', 'dev', '--config', `${directory}/wrangler-proof.json`,
				'--env-file', `${directory}/empty.env`, '--local', '--ip', '127.0.0.1', '--port', port, '--inspector-port', inspectorPort,
				'--local-protocol', 'https', '--https-key-path', `${directory}/server.key`, '--https-cert-path', `${directory}/server.pem`,
				'--persist-to', `${directory}/worker-state`, '--log-level', 'error'], {
				stdout: Bun.file(`${directory}/worker.log`), stderr: Bun.file(`${directory}/worker-error.log`),
				env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '' }
			});
		}
		let worker = launch();
		async function ready(path = '/') {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (worker.exitCode !== null) throw new Error('Disposable Worker stopped unexpectedly');
				try {
					const response = await fetch(origin + path, { tls: { ca }, signal: AbortSignal.timeout(1000) });
					await response.body?.cancel();
					if (response.ok) return;
				} catch { /* Wait for this disposable process only. */ }
				await Bun.sleep(200);
			}
			throw new Error('Trusted HTTPS Worker failed to start');
		}
		let closing: Promise<void> | undefined;
		function close() {
			closing ??= (async () => {
				try { await getContext()?.close(); }
				finally {
					worker.kill(); await worker.exited;
					for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, interrupted);
				}
			})();
			return closing;
		}
		const interrupted = () => { void close().finally(() => process.exit(1)); };
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, interrupted);
		async function restart() {
			worker.kill(); await worker.exited; worker = launch(); await ready();
		}
		return { ready, close, restart };
	}
	return { directory, origin, api, publicKey, anonKey, serviceKey, password, secrets, safe, ca, sql, createUser, startWorker };
}
