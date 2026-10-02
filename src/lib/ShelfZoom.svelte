<script lang="ts">
	// The shared shelf drill-down: one stage shows the wall or, zoomed in, one
	// cabinet. Zooming animates only this stage: an inert copy of the outgoing
	// level stays on screen while the wall scales about the chosen cabinet and
	// the cabinet grows out of its face (zooming out plays the same in reverse),
	// and the stage height follows. Nothing outside the stage is snapshotted, so
	// the surrounding sheet keeps its backdrop. Reduced motion swaps instantly.
	// Each level marks its outline `data-zoom-frame` and each wall cabinet
	// `data-zoom-face={id}`; ShelfDiagram does both. The caller owns `open`.
	import { tick, type Snippet } from 'svelte';
	import MagnifyingGlassMinusIcon from 'phosphor-svelte/lib/MagnifyingGlassMinusIcon';
	import Icon from '#lib/Icon.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	import { itemTitle } from '#lib/ui.js';

	let { open, title, headingLevel, onchange, wall, cabinet, element = $bindable(), disabled = false, class: className }: {
		open: string | null; title: string; headingLevel?: 2 | 3 | 4 | 5; onchange: (id: string | null) => void;
		wall: Snippet<[(id: string) => void]>; cabinet: Snippet; element?: HTMLElement; disabled?: boolean; class?: string;
	} = $props();
	const i18n = getI18n(), uid = $props.id();
	const timing = { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
	let stage = $state<HTMLElement>(), level = $state<HTMLElement>(), ghost = $state<HTMLElement>();
	let settle: (() => void) | undefined;

	function zoom(id: string, next: string | null) {
		settle?.();
		const face = () => level?.querySelector<HTMLElement>(`[data-zoom-face="${CSS.escape(id)}"]`) ?? null;
		const focus = () => (next ? document.getElementById(`${uid}-title`) : face()?.closest<HTMLElement>('button') ?? face())
			?.focus({ preventScroll: true });
		if (!stage || !level || !ghost || matchMedia('(prefers-reduced-motion: reduce)').matches) {
			onchange(next); void tick().then(focus); return;
		}
		// Stage-relative boxes, so a sheet that scrolls to the new level keeps them aligned.
		const box = (target: Element | null) => {
			const outer = stage!.getBoundingClientRect(), inner = target?.getBoundingClientRect();
			return inner && { x: inner.left - outer.left, y: inner.top - outer.top, width: inner.width };
		};
		const zoomingIn = !open, before = box(level.querySelector(zoomingIn ? `[data-zoom-face="${CSS.escape(id)}"]` : '[data-zoom-frame]'));
		const fromHeight = stage.offsetHeight, copy = level.cloneNode(true) as HTMLElement;
		const offsets = Array.from(level.querySelectorAll<HTMLElement>('[role="region"]'), (region) => ({ left: region.scrollLeft, top: region.scrollTop }));
		for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
		onchange(next);
		void tick().then(() => {
			focus();
			const after = box(level!.querySelector(zoomingIn ? '[data-zoom-frame]' : `[data-zoom-face="${CSS.escape(id)}"]`));
			const wallFace = zoomingIn ? before : after, frame = zoomingIn ? after : before;
			if (!stage || !level || !ghost || !wallFace || !frame || !wallFace.width) return;
			// eslint-disable-next-line svelte/no-dom-manipulating -- Svelte renders no children into the ghost layer.
			ghost.replaceChildren(copy);
			// cloneNode omits scroll positions; keep panned walls aligned with the chosen cabinet.
			copy.querySelectorAll<HTMLElement>('[role="region"]').forEach((region, index) => { region.scrollLeft = offsets[index].left; region.scrollTop = offsets[index].top; });
			const wallLevel = zoomingIn ? copy : level, cabinetLevel = zoomingIn ? level : copy;
			const scale = frame.width / wallFace.width;
			wallLevel.style.transformOrigin = `${wallFace.x}px ${wallFace.y}px`;
			cabinetLevel.style.transformOrigin = `${frame.x}px ${frame.y}px`;
			cabinetLevel.style.zIndex = '1';
			stage.style.overflow = 'clip';
			// Written as the zoom-in; zooming out plays the same keyframes backwards.
			const direction = zoomingIn ? 'normal' : 'reverse';
			const animations = [
				wallLevel.animate([{ transform: 'none', opacity: 1 },
					{ transform: `translate(${frame.x - wallFace.x}px, ${frame.y - wallFace.y}px) scale(${scale})`, opacity: 0 }], { ...timing, direction }),
				cabinetLevel.animate([{ transform: `translate(${wallFace.x - frame.x}px, ${wallFace.y - frame.y}px) scale(${1 / scale})`, opacity: 0 },
					{ opacity: 1, offset: 0.3 }, { transform: 'none', opacity: 1 }], { ...timing, direction }),
				stage.animate([{ height: `${fromHeight}px` }, { height: `${level.offsetHeight}px` }], timing)
			];
			settle = () => {
				settle = undefined;
				for (const animation of animations) animation.cancel();
				// eslint-disable-next-line svelte/no-dom-manipulating -- see above; only the inert copy is removed.
				ghost?.replaceChildren();
				stage?.style.removeProperty('overflow');
				for (const target of [wallLevel, cabinetLevel]) { target.style.removeProperty('transform-origin'); target.style.removeProperty('z-index'); }
			};
			void Promise.all(animations.map((animation) => animation.finished)).then(() => settle?.(), () => {});
		});
	}
</script>

<!-- Finish the zoom before focused descendants measure their visible scroll region. -->
<div bind:this={element} class={["min-w-0", className]} onfocuscapture={() => settle?.()}>
	<div class="mb-2 flex min-h-11 items-center justify-between gap-3">
		<svelte:element this={headingLevel ? `h${headingLevel}` : 'p'} class={itemTitle} id={`${uid}-title`} tabindex="-1">{title}</svelte:element>
		{#if open}<Button variant="outline" size="sm" type="button" {disabled} onclick={() => open && zoom(open, null)}><Icon icon={MagnifyingGlassMinusIcon} class="size-4" />{i18n.m.shelfMap.showWall}</Button>{/if}
	</div>
	<div bind:this={stage} class="relative">
		<div bind:this={level} class="relative">{#if open}{@render cabinet()}{:else}{@render wall((id) => zoom(id, id))}{/if}</div>
		<div bind:this={ghost} class="pointer-events-none absolute inset-x-0 top-0" aria-hidden="true" inert></div>
	</div>
</div>
