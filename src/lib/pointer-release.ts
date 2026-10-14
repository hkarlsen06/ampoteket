// Feedback that appears as a field is left must not move what is being clicked: the
// field blurs on pointer-down, and a control that shifts before pointer-up loses the
// click. Such feedback waits until the pointer is released and the click has landed.
let pressed = false;
let queued: (() => void)[] = [];

function release() {
	pressed = false;
	const run = queued; queued = [];
	if (run.length) setTimeout(() => run.forEach(apply => apply()));
}

if (typeof window !== 'undefined') {
	window.addEventListener('pointerdown', () => { pressed = true; }, true);
	window.addEventListener('pointerup', release, true);
	window.addEventListener('pointercancel', release, true);
}

/** Runs `apply` now, or after the pointer that is down is released. */
export function afterPointerRelease(apply: () => void): void {
	if (pressed) queued.push(apply);
	else apply();
}
