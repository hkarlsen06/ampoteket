/**
 * Network faults on the Convex sync WebSocket, for the admin, labels and shelf
 * browser proofs. (scripts/web-proof/convex-socket.ts is a separate watcher
 * used by other proofs; install only one of them on a browser context.)
 *
 * The app talks to Convex over one WebSocket, so there is no per-request HTTP
 * to abort. This router sits between the page and the disposable backend and
 * forwards every frame unchanged and in order, except where a proof asks:
 *
 * - `lose(path)`: a matching mutation reaches the server and commits, but the
 *   page receives a failure without a domain code instead of its reply: the
 *   outcome is unknown to the app, as with a lost acknowledgement.
 * - `hold(path)`: a matching mutation commits, but its reply is withheld until
 *   `release()`. `discard()` drops replies withheld so far (their page reloaded).
 * - `reject(path, code)`: a matching mutation never reaches the server and is
 *   answered with a domain rejection carrying `code`.
 * - `before(path, action)`: run `action` (a fixture write, say) before a
 *   matching mutation is forwarded; later frames wait for it, keeping order.
 * - `failReads(path)`: results of matching queries arrive as `QueryFailed`, as
 *   the backend reports a query that threw. New reads fail at once; a live
 *   subscription fails at its next update.
 *
 * Paths are Convex function names (`products:save`). Frames carrying tokens
 * (`Authenticate`) are forwarded and never recorded.
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test';

type Frame = Record<string, unknown> & { type: string };
type Hold = { path: string; sent: string[]; held: { socket: WebSocketRoute; frame: string; version: () => unknown }[]; released: boolean };
type Failure = { path: string; active: boolean };
type Interception =
	| { kind: 'lose'; path: string; sent: string[] }
	| { kind: 'reject'; path: string; code: string; sent: string[] }
	| { kind: 'before'; path: string; action: (args: unknown) => Promise<void> | void; sent: string[] };

const canonical = (path: unknown) => String(path).replace(/\.js:/, ':');

export async function convexSocket(context: BrowserContext, convexUrl: string) {
	const origin = convexUrl.replace(/^http/, 'ws');
	const mutations: { path: string; args: string }[] = [];
	const holds = new Set<Hold>();
	const failures = new Set<Failure>();
	const interceptions = new Set<Interception>();

	await context.routeWebSocket(url => url.href.startsWith(origin), socket => {
		const server = socket.connectToServer();
		// Query IDs belong to one connection; a reconnect adds its queries again.
		const queries = new Map<number, string>();
		const heldHere = new Map<string, Hold>();
		const lostHere = new Set<string>();
		let chunks: string[] = [], order = Promise.resolve(), version: unknown = null;
		const forward = (text: string) => { try { server.send(text); } catch { /* The page has gone. */ } };
		const reply = (frame: Frame) => { try { socket.send(JSON.stringify(frame)); } catch { /* The page has gone. */ } };

		socket.onMessage(message => {
			const text = String(message);
			const frame = JSON.parse(text) as Frame;
			if (frame.type === 'ModifyQuerySet') {
				for (const change of frame.modifications as Frame[]) {
					if (change.type === 'Add') queries.set(change.queryId as number, canonical(change.udfPath));
				}
			}
			if (frame.type !== 'Mutation') { order = order.then(() => forward(text)); return; }
			const path = canonical(frame.udfPath), args = JSON.stringify(frame.args), requestId = String(frame.requestId);
			mutations.push({ path, args });
			for (const hold of holds) {
				if (hold.path === path && !hold.released) { hold.sent.push(args); heldHere.set(requestId, hold); }
			}
			const rule = [...interceptions].find(item => item.path === path);
			rule?.sent.push(args);
			order = order.then(async () => {
				if (rule?.kind === 'reject') {
					reply({ type: 'MutationResponse', requestId: frame.requestId, success: false, result: rule.code, logLines: [], errorData: { code: rule.code, message: rule.code } });
					return;
				}
				if (rule?.kind === 'before') await rule.action((frame.args as unknown[])[0]);
				if (rule?.kind === 'lose') lostHere.add(requestId);
				forward(text);
			});
		});

		const deliver = (frame: Frame) => {
			if (frame.type === 'MutationResponse') {
				const requestId = String(frame.requestId);
				if (lostHere.delete(requestId)) {
					// The reply is lost: a failure without a code, whatever the server did.
					reply({ type: 'MutationResponse', requestId: frame.requestId, success: false, result: 'Disposable proof: reply lost', logLines: [] });
					return;
				}
				const hold = heldHere.get(requestId);
				if (hold) {
					heldHere.delete(requestId);
					if (!hold.released) { hold.held.push({ socket, frame: JSON.stringify(frame), version: () => version }); return; }
				}
			}
			if (frame.type === 'Transition') {
				version = frame.endVersion;
				const failing = [...failures].filter(failure => failure.active);
				if (failing.length) {
					frame.modifications = (frame.modifications as Frame[]).map(change => {
						const path = queries.get(change.queryId as number);
						if (change.type !== 'QueryUpdated' || !failing.some(failure => failure.path === path)) return change;
						return { type: 'QueryFailed', queryId: change.queryId, errorMessage: 'Disposable proof: read failed', logLines: [], journal: change.journal ?? null };
					});
				}
			}
			reply(frame);
		};
		server.onMessage(message => {
			const frame = JSON.parse(String(message)) as Frame;
			// Large transitions arrive in parts; reassemble so they can be inspected.
			if (frame.type === 'TransitionChunk') {
				chunks.push(frame.chunk as string);
				if (chunks.length < (frame.totalParts as number)) return;
				const whole = JSON.parse(chunks.join('')) as Frame;
				chunks = [];
				deliver(whole);
				return;
			}
			deliver(frame);
		});
	});

	function intercept(rule: Interception) {
		interceptions.add(rule);
		return { sent: rule.sent, stop() { interceptions.delete(rule); } };
	}
	return {
		/** Arguments (JSON of the argument list) of every mutation sent to `path`, in order. */
		sent(path: string) { return mutations.filter(mutation => mutation.path === path).map(mutation => mutation.args); },
		/** Matching mutations commit, but the page sees an unknown outcome. */
		lose(path: string) { return intercept({ kind: 'lose', path, sent: [] }); },
		/** Matching mutations are refused before reaching the server, with this domain code. */
		reject(path: string, code: string) { return intercept({ kind: 'reject', path, code, sent: [] }); },
		/** Run `action(args)` before each matching mutation reaches the server. */
		before(path: string, action: (args: unknown) => Promise<void> | void) { return intercept({ kind: 'before', path, action, sent: [] }); },
		/** Withhold replies to `path` mutations sent from now on. */
		hold(path: string) {
			const hold: Hold = { path, sent: [], held: [], released: false };
			holds.add(hold);
			return {
				/** Arguments of each held command, so a retry can be compared with the original. */
				sent: hold.sent,
				/** Drop the replies withheld so far (their page reloaded) and keep holding. */
				discard() { hold.held.length = 0; },
				/**
				 * Deliver withheld replies whose page is still open, and stop holding. The
				 * client settles a mutation only on a transition at or after its timestamp,
				 * and the covering one has passed, so an empty transition at the current
				 * version follows each reply, as when the server sends the reply first.
				 */
				release() {
					hold.released = true; holds.delete(hold);
					for (const { socket, frame, version } of hold.held.splice(0)) {
						try {
							socket.send(frame);
							const current = version();
							if (current !== null) socket.send(JSON.stringify({ type: 'Transition', startVersion: current, endVersion: current, modifications: [] }));
						} catch { /* That page has gone. */ }
					}
				}
			};
		},
		/** Fail reads of `path` until stopped. */
		failReads(path: string) {
			const failure: Failure = { path, active: true };
			failures.add(failure);
			return { stop() { failure.active = false; failures.delete(failure); } };
		}
	};
}
