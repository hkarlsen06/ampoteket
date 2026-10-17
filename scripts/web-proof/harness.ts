import { expect, type BrowserContext, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

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

/** SvelteKit may hydrate after the load event; wait before firing events or reading client-side URL changes. */
export async function waitForHydration(page: Page) {
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
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

type Row = Record<string, unknown>;
export type Email = { to: string[]; subject: string; html: string; text: string };
/** The single-use password link in an invitation or reset email. */
export function passwordLink(email: Email): URL {
	const href = /href="([^"]*token_hash[^"]*)"/.exec(email.html)?.[1];
	assert.ok(href, 'Email contains a password link');
	return new URL(href.replaceAll('&amp;', '&').replaceAll('&#38;', '&'));
}

/** Services and credentials belong to the disposable backend created by test-web.sh. */
export async function proofEnvironment() {
	const [directory, port, inspectorPort] = process.argv.slice(2);
	assert.match(directory ?? '', /^\/tmp\/ampoteket-web\.[A-Za-z0-9]{8}$/);
	for (const value of [port, inspectorPort]) {
		assert.match(value ?? '', /^\d+$/);
		assert.ok(Number(value) > 0 && Number(value) <= 65535, 'Use scripts/test-web.sh');
	}
	const origin = `https://localhost:${port}`;
	const status = await Bun.file(`${directory}/status.json`).json() as { convexUrl: string; adminKey: string; serverKey: string; emailPort: number };
	const convexUrl = new URL(status.convexUrl);
	assert.ok(convexUrl.protocol === 'http:' && convexUrl.hostname === '127.0.0.1', 'Proof refuses a nonlocal backend');
	const { adminKey, serverKey } = status;
	const password = crypto.randomUUID() + '!Aa7';
	const secrets = [adminKey, serverKey, password];
	const safe = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
		.replace(/[a-f0-9]{64}/g, '[redacted]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]');
	const ca = await Bun.file(`${directory}/ca.pem`).text();

	const admin = new ConvexHttpClient(convexUrl.origin, { logger: false });
	(admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
	/** Call an internal function by name (`seed:staff`), as `convex run` does. */
	async function run<T = unknown>(kind: 'query' | 'mutation', name: string, args: Row = {}): Promise<T> {
		const call = admin[kind] as (fn: never, args: Row) => Promise<T>;
		try { return await call.call(admin, makeFunctionReference(name) as never, args); }
		catch (error) { throw new Error(`Disposable fixture ${name} failed: ${safe(String(error))}`); }
	}
	/** Test-only table access (convex/fixtures.ts); never available in production. */
	const fixtures = {
		insert: (table: string, rows: Row[]) => run<number>('mutation', 'fixtures:insert', { table, rows }),
		rows: <T extends Row = Row>(table: string, where?: Row) => run<T[]>('query', 'fixtures:rows', { table, ...(where ? { where } : {}) }),
		patch: (table: string, where: Row, changes: Row) => run<number>('mutation', 'fixtures:patch', { table, where, changes }),
		remove: (table: string, where: Row) => run<number>('mutation', 'fixtures:remove', { table, where })
	};
	/** A staff member who signs in with `password`. */
	async function createStaff(email: string, displayName = 'Proof volunteer', active = true) {
		return await run<{ staffId: string; authUserId: string }>('mutation', 'seed:staff', { email, password, displayName, active });
	}
	/** A signed-in user without membership. */
	async function createUser(email: string) {
		return (await run<{ authUserId: string }>('mutation', 'fixtures:user', { email, password })).authUserId;
	}

	/** Captures invitation and reset email instead of sending it (Resend stand-in). */
	const outbox: Email[] = [];
	let emailServer: ReturnType<typeof Bun.serve> | undefined;
	function startEmail() {
		emailServer ??= Bun.serve({ port: status.emailPort, hostname: '127.0.0.1', async fetch(request) {
			outbox.push(await request.json() as Email);
			return Response.json({ id: `proof-${outbox.length}` });
		} });
		return outbox;
	}

	async function startWorker(getContext: () => BrowserContext | undefined, config?: Record<string, unknown>) {
		await writeFile(`${directory}/wrangler-proof.json`, JSON.stringify(config ?? {
			name: 'ampoteket-site-proof', main: `${directory}/site/cloudflare/_worker.js`,
			compatibility_date: '2026-09-18', compatibility_flags: ['nodejs_als'], workers_dev: false,
			assets: { directory: `${directory}/site/cloudflare`, binding: 'ASSETS' },
			vars: { PUBLIC_CONVEX_URL: convexUrl.origin, CHECKOUT_SERVER_KEY: serverKey, CHECKOUT_ALLOWED_ORIGIN: origin, SALES_OPEN: 'true' },
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
					emailServer?.stop(true);
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
	return { directory, origin, convexUrl: convexUrl.origin, serverKey, password, secrets, safe, ca, run, fixtures, createStaff, createUser, startEmail, outbox, startWorker };
}
