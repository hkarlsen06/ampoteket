/**
 * Test-only view of the browser's Convex WebSocket, through Playwright's
 * routeWebSocket. The shop's reads and staff mutations share one socket, so
 * HTTP routes cannot see them. This proxy records every query subscription and
 * mutation by function name and can fail or hold one result, the way the
 * Supabase proofs aborted or held a single PostgREST request. All other traffic
 * passes through unchanged and in order.
 *
 * A failed result carries no domain code, so the app sees what a lost response
 * or unreachable backend gives it: an unknown outcome. A held query result is
 * removed from its transition and delivered later on its own at the then-current
 * version, so other reads keep flowing; a newer result for the same query
 * replaces it.
 */
import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';

type Json = Record<string, unknown>;
/** `update` counts the results a query subscription has received (0 for its first). */
export type ConvexCall = { kind: 'query' | 'mutation'; path: string; args: Json; update: number };
/** A promise holds the result until it settles. */
export type Decision = 'pass' | 'fail' | Promise<unknown>;
export type Rule = (call: ConvexCall) => Decision | undefined | void;

// The client canonicalizes `catalog:page` as `catalog.js:page` on older servers.
const functionName = (udfPath: string) => udfPath.replace(/\.js:/, ':');
const failure = 'Disposable proof: result withheld';

export async function watchConvex(target: BrowserContext | Page) {
	/** Every query subscription and mutation the browser sent, in order. */
	const calls: Omit<ConvexCall, 'update'>[] = [];
	const rules = new Set<Rule>();
	function decide(call: ConvexCall): Decision {
		for (const rule of rules) { const decision = rule(call); if (decision) return decision; }
		return 'pass';
	}
	function proxy(browser: WebSocketRoute) {
		const server = browser.connectToServer();
		const queries = new Map<number, { call: Omit<ConvexCall, 'update'>; update: number }>();
		const mutations = new Map<number, Omit<ConvexCall, 'update'>>();
		const held = new Map<number, Json>();
		let version: unknown = null, chunks: string[] = [], open = true;
		browser.onClose(() => { open = false; server.close(); });
		server.onClose(() => { open = false; browser.close(); });
		browser.onMessage((message) => {
			const data = JSON.parse(String(message));
			if (data.type === 'ModifyQuerySet') for (const change of data.modifications) {
				if (change.type !== 'Add') continue;
				const call = { kind: 'query' as const, path: functionName(change.udfPath), args: change.args?.[0] ?? {} };
				queries.set(change.queryId, { call, update: 0 }); calls.push(call);
			}
			if (data.type === 'Mutation') {
				const call = { kind: 'mutation' as const, path: functionName(data.udfPath), args: data.args?.[0] ?? {} };
				mutations.set(data.requestId, call); calls.push(call);
			}
			server.send(message);
		});
		function release(queryId: number, result: Json) {
			if (held.get(queryId) !== result) return;
			held.delete(queryId);
			if (open && version !== null) browser.send(JSON.stringify({ type: 'Transition', startVersion: version, endVersion: version, modifications: [result] }));
		}
		function transition(data: Json) {
			const kept: Json[] = [];
			for (const change of data.modifications as Json[]) {
				const queryId = change.queryId as number;
				held.delete(queryId);
				const entry = queries.get(queryId);
				if (change.type === 'QueryRemoved') queries.delete(queryId);
				if (change.type === 'QueryUpdated' && entry) {
					const decision = decide({ ...entry.call, update: entry.update++ });
					if (decision === 'fail') {
						kept.push({ type: 'QueryFailed', queryId, errorMessage: failure, logLines: [], journal: change.journal ?? null });
						continue;
					}
					if (decision !== 'pass') {
						held.set(queryId, change);
						void decision.finally(() => release(queryId, change));
						continue;
					}
				}
				kept.push(change);
			}
			version = data.endVersion;
			browser.send(JSON.stringify({ ...data, modifications: kept }));
		}
		server.onMessage((message) => {
			const data = JSON.parse(String(message));
			if (data.type === 'TransitionChunk') {
				chunks.push(data.chunk);
				if (chunks.length === data.totalParts) { const whole = JSON.parse(chunks.join('')); chunks = []; transition(whole); }
				return;
			}
			if (data.type === 'Transition') { transition(data); return; }
			if (data.type === 'MutationResponse' && mutations.has(data.requestId)) {
				const call = mutations.get(data.requestId)!;
				mutations.delete(data.requestId);
				const decision = decide({ ...call, update: 0 });
				if (decision === 'fail') {
					browser.send(JSON.stringify({ type: 'MutationResponse', requestId: data.requestId, success: false, result: failure, logLines: [] }));
					return;
				}
				// The mutation has committed; the browser waits for its response. The client
				// resolves it at the next transition, which passed meanwhile, so repeat that version.
				if (decision !== 'pass') {
					void decision.finally(() => {
						if (!open) return;
						browser.send(message);
						if (version !== null) browser.send(JSON.stringify({ type: 'Transition', startVersion: version, endVersion: version, modifications: [] }));
					});
					return;
				}
			}
			browser.send(message);
		});
	}
	await target.routeWebSocket(/\/api\/[^/]+\/sync$/, proxy);
	return {
		calls,
		/** Calls of one function, optionally only those whose arguments match. */
		of(path: string, match: (args: Json) => boolean = () => true) {
			return calls.filter((call) => call.path === path && match(call.args));
		},
		/** The first rule that returns a decision wins; the returned function removes it. */
		rule(rule: Rule) { rules.add(rule); return () => { rules.delete(rule); }; }
	};
}

/**
 * The same proxy with shorthand by function name: `fail`/`restore` every read of
 * a query, `withhold` the response of the next mutations (they commit, and the
 * browser sees an outcome without a code: unknown), and `hold` the next
 * mutation's response until `release()`, keeping the command in flight.
 */
export async function interceptConvex(target: BrowserContext | Page) {
	const watch = await watchConvex(target);
	const failing = new Set<string>();
	const withholding = new Map<string, number>();
	const holding = new Map<string, (() => Promise<void>)[]>();
	watch.rule((call) => {
		if (call.kind === 'query') return failing.has(call.path) ? 'fail' : undefined;
		const left = withholding.get(call.path) ?? 0;
		if (left > 0) { withholding.set(call.path, left - 1); return 'fail'; }
		return holding.get(call.path)?.shift()?.();
	});
	const names = (kind: ConvexCall['kind']) => watch.calls.filter((call) => call.kind === kind);
	return {
		...watch,
		/** Mutations sent, retries included, as `{ name, args }`. */
		get mutations() { return names('mutation').map((call) => ({ name: call.path, args: call.args })); },
		/** Names of the queries subscribed to, one-off reads included. */
		get queries() { return names('query').map((call) => call.path); },
		/** Reads of one query since `from` (an index into `queries`). */
		reads(name: string, from = 0) { return names('query').slice(from).filter((call) => call.path === name).length; },
		/** Mutations of one function since `from` (an index into `mutations`). */
		sent(name: string, from = 0) { return names('mutation').slice(from).filter((call) => call.path === name).map((call) => ({ name: call.path, args: call.args })); },
		fail(name: string) { failing.add(name); },
		restore(name: string) { failing.delete(name); },
		withhold(name: string, count = 1) { withholding.set(name, (withholding.get(name) ?? 0) + count); },
		hold(name: string) {
			let seen!: () => void, release!: () => void;
			const committed = new Promise<void>((resolve) => { seen = resolve; });
			const released = new Promise<void>((resolve) => { release = resolve; });
			holding.set(name, [...(holding.get(name) ?? []), () => { seen(); return released; }]);
			/** `committed` resolves once the backend has answered; the browser has not seen it yet. */
			return { committed, release };
		}
	};
}
