<script lang="ts">
	import type { Snippet } from 'svelte';
	import { lede as ledeClass, pageHeading } from '#lib/ui.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { getI18n } from '#lib/i18n/index.js';
	let { heading, lede, children }: { heading: string; lede?: string; children: Snippet } = $props();
	const i18n = getI18n();
</script>

<!-- The drawer wall on a night panel beside the form (a band above it on phones),
     with the sign's lit red dot and the square mark. Decorative: the form stands alone.
     Sign-in and password setup share it, so the two read as one place. -->
<Card.Root class="mx-auto max-w-4xl gap-0 py-0 md:grid md:grid-cols-[5fr_6fr]">
	<div class="scheme-night relative min-h-36 rounded-t-xl bg-night md:rounded-l-xl md:rounded-tr-none" aria-hidden="true">
		<img class="absolute inset-0 size-full rounded-[inherit] object-cover object-[50%_35%] mask-b-from-30% md:mask-b-from-55%"
			srcset="/photos/drawers-960.webp 960w, /photos/drawers-1280.webp 1280w" sizes="(min-width: 48rem) 25rem, 100vw"
			src="/photos/drawers-960.webp" width="3418" height="2757" alt="" decoding="async" />
		<div class="absolute inset-x-0 bottom-0 flex items-center gap-3 p-5 md:p-8">
			<img src="/brand/mark-square-64.png" alt="" width="40" height="40" class="size-10 rounded-md" />
			<span class="inline-flex items-center gap-2.5 text-sm text-night-muted"><span class="size-1.5 rounded-full bg-night-accent shadow-[0_0_0.5rem_var(--night-accent)]"></span>{i18n.m.admin.heading}</span>
		</div>
	</div>
	<div class="grid content-start gap-6 p-5 md:p-10">
		<header class="grid gap-2">
			<h1 class={pageHeading}>{heading}</h1>
			{#if lede}<p class={ledeClass}>{lede}</p>{/if}
		</header>
		{@render children()}
	</div>
</Card.Root>
