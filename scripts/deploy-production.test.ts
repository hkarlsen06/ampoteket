import { expect, test } from 'bun:test';
import { unstable_readConfig } from 'wrangler';
import { deployProduction, requireValidation } from './deploy-production';
import type { Fetcher } from '../src/lib/api';

const sha = 'a'.repeat(40);
const passed = { head_sha: sha, event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/validation' };
const noWait = async () => {};

test('deployment waits for this exact commit and rejects failed, unavailable or missing validation', async () => {
	const states = [[], [{ ...passed, head_sha: 'b'.repeat(40) }], [{ ...passed, status: 'in_progress', conclusion: null }], [passed]];
	let pauses = 0;
	await requireValidation(sha, async (_url, options) => {
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		return Response.json({ workflow_runs: states.shift() });
	}, async () => { pauses++; });
	expect(pauses).toBe(3);
	for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
		await expect(requireValidation(sha, async () => Response.json({ workflow_runs: [{ ...passed, conclusion }] }), noWait)).rejects.toThrow('nothing deployed');
	}
	await expect(requireValidation(sha, async () => new Response('', { status: 403 }), noWait)).rejects.toThrow('nothing deployed');
	await expect(requireValidation(sha, async () => Response.json({ workflow_runs: [] }), noWait)).rejects.toThrow('Nothing deployed');
});

function harness(failure = '') {
	const calls: string[][] = [];
	let deploymentReads = 0;
	const config = unstable_readConfig({ env: 'production' });
	const bindings = [
		...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
		...(config.ratelimits ?? []).map((limit: { name: string }) => ({ ...limit, type: 'ratelimit' })),
		...['SUPABASE_SECRET_KEY', 'RESEND_API_KEY'].map((name) => ({ name, type: 'secret_text' }))
	];
	const command = (args: string[]) => {
		calls.push(args);
		if (args.includes('rev-parse')) return sha;
		if (args.includes('deploy') && failure === 'publish') throw new Error('lost upload response');
		if (args.includes('deployments')) {
			if (++deploymentReads > 1 && failure === 'deployment-list') throw new Error('metadata unavailable');
			return JSON.stringify([{ versions: [{ version_id: deploymentReads === 1 ? 'previous' : 'new', percentage: 100 }] }]);
		}
		if (args.includes('view')) {
			if (failure === 'version') throw new Error('version unavailable');
			if (failure === 'json') return '{';
			return JSON.stringify({ resources: { bindings: failure === 'bindings' ? [] : bindings } });
		}
		return '';
	};
	const fetcher: Fetcher = async (input, options) => {
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		const url = String(input);
		if (url.startsWith('https://api.github.com/')) return Response.json({ workflow_runs: [{ ...passed, conclusion: failure === 'ci' ? 'failure' : 'success' }] });
		if (failure === 'network') throw new TypeError('fetch failed');
		if (url.startsWith('http:')) return new Response(null, { status: failure === 'http' ? 200 : 308, headers: { Location: 'https://ampoteket.no/admin/login' } });
		return new Response('Contact list', { status: failure === 'help' ? 503 : 200, headers: failure === 'hsts' ? {} : { 'Strict-Transport-Security': 'max-age=31536000' } });
	};
	return { calls, command, fetcher };
}

test('failed CI never uploads; successful verification keeps the new release', async () => {
	const failed = harness('ci');
	await expect(deployProduction(failed.command, failed.fetcher, noWait)).rejects.toThrow();
	expect(failed.calls.some((args) => args.includes('deploy'))).toBe(false);
	const good = harness();
	await deployProduction(good.command, good.fetcher, noWait);
	expect(good.calls.some((args) => args.includes('deploy'))).toBe(true);
	expect(good.calls.some((args) => args.includes('rollback'))).toBe(false);
});

test('all post-publish failures roll back to the recorded prior version', async () => {
	for (const failure of ['publish', 'deployment-list', 'version', 'json', 'bindings', 'network', 'help', 'http', 'hsts']) {
		const probe = harness(failure);
		await expect(deployProduction(probe.command, probe.fetcher, noWait)).rejects.toThrow();
		const rollback = probe.calls.find((args) => args.includes('rollback'));
		expect(rollback).toContain('previous');
		expect(rollback).toContain('--yes');
	}
});

test('changes during CI or build cannot borrow another revision\'s validation', async () => {
	for (const inspection of [2, 3]) for (const mutation of ['dirty', 'head']) {
		const probe = harness();
		let inspections = 0;
		const command = (args: string[]) => {
			if (args.includes('status')) {
				inspections++;
				if (inspections === inspection && mutation === 'dirty') return ' M src/hooks.server.ts';
			}
			if (args.includes('rev-parse') && inspections === inspection && mutation === 'head') return 'b'.repeat(40);
			return probe.command(args);
		};
		await expect(deployProduction(command, probe.fetcher, noWait)).rejects.toThrow();
		expect(probe.calls.some((args) => args.includes('deploy'))).toBe(false);
	}
});

test('failed rollback preserves both errors and the prior version for recovery', async () => {
	const probe = harness('network');
	try {
		await deployProduction((args) => {
			if (args.includes('rollback')) throw new Error('rollback unavailable');
			return probe.command(args);
		}, probe.fetcher, noWait);
		throw new Error('deployment unexpectedly passed');
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		const failure = error as AggregateError;
		expect(failure.message).toContain('Previous version: previous');
		expect(failure.errors.map((entry: Error) => entry.message)).toEqual(['fetch failed', 'rollback unavailable']);
	}
});
