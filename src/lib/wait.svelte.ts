/** Resolve once `condition` holds, re-checking whenever the state it reads changes (or after `timeoutMs`). */
export function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve) => {
		const stop = $effect.root(() => {
			$effect(() => { if (condition()) { queueMicrotask(stop); clearTimeout(timer); resolve(); } });
		});
		const timer = setTimeout(() => { stop(); resolve(); }, timeoutMs);
	});
}
