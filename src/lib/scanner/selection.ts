export type QrDetection = { value: string; corners: { x: number; y: number }[] };

/** Coordinates are normalized to the actual decoded crop, not the full video.
 * Choose spatially before parsing: never skip a central foreign QR in favour
 * of an unrelated valid label near the edge. Equally aimed codes need re-aiming. */
export function nearestQr(results: QrDetection[]): QrDetection | null {
	const ranked = results.flatMap((result) => {
		if (result.corners.length !== 4 || result.corners.some(({ x, y }) =>
			!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)) return [];
		const x = result.corners.reduce((sum, point) => sum + point.x, 0) / 4;
		const y = result.corners.reduce((sum, point) => sum + point.y, 0) / 4;
		return [{ result, distance: Math.hypot(x - 0.5, y - 0.5) }];
	}).sort((a, b) => a.distance - b.distance);
	if (!ranked.length || (ranked[1] && ranked[1].distance - ranked[0].distance < 0.025)) return null;
	return ranked[0].result;
}

/** Rearm from observed absence, never a timer that automatically ends review.
 * Three fresh frames and 600 ms reduce single-frame decoder misses. A deliberate
 * rearm remains available because this is a visual heuristic, not identity proof. */
export class ScanGate {
	accepting = true;
	private blocked = new Map<string, { absent: number; since: number | null }>();
	pause() { this.accepting = false; }
	resume() { this.accepting = true; }
	rearm() { this.blocked.clear(); }
	get hasBlocked() { return this.blocked.size > 0; }
	observe(results: QrDetection[], now: number): { value: string | null; duplicate: boolean } {
		if (!this.accepting) return { value: null, duplicate: false };
		for (const [value, state] of this.blocked) {
			if (results.some((result) => result.value === value)) { state.absent = 0; state.since = null; }
			else {
				state.absent += 1; state.since ??= now;
				if (state.absent >= 3 && now - state.since >= 600) this.blocked.delete(value);
			}
		}
		const candidate = nearestQr(results);
		if (!candidate) return { value: null, duplicate: false };
		if (this.blocked.has(candidate.value)) return { value: null, duplicate: true };
		// Synchronous and before product lookup/basket work can yield.
		this.accepting = false;
		this.blocked.set(candidate.value, { absent: 0, since: null });
		return { value: candidate.value, duplicate: false };
	}
}
