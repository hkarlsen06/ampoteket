/** Reveal a focused shelf control inside its viewport and any containing sheet,
 * without moving the document or animating keyboard navigation. */
export function revealShelfFocus(element: HTMLElement, viewport: HTMLElement | null) {
	for (let region = viewport; region && region !== document.body; region = region.parentElement) {
		if (!/(auto|scroll)/.test(getComputedStyle(region).overflow)) continue;
		const frame = region.getBoundingClientRect(), target = element.getBoundingClientRect();
		if (target.left < frame.left + 4) region.scrollLeft -= frame.left + 4 - target.left;
		else if (target.right > frame.right - 4) region.scrollLeft += target.right - frame.right + 4;
		if (target.top < frame.top + 4) region.scrollTop -= frame.top + 4 - target.top;
		else if (target.bottom > frame.bottom - 4) region.scrollTop += target.bottom - frame.bottom + 4;
	}
}
