<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';

	// What tells a product from look-alikes (productVariants), one outline badge per
	// specification under the name. Inside the name's heading and link, so look-alike
	// links have different names; the hidden commas keep the spoken name readable.
	let { parts, prominent = false, children }: { parts: string[]; prominent?: boolean; children?: Snippet } = $props();
</script>

{#if parts.length}<span class="sr-only">,&nbsp;</span><span class="mt-1.5 flex flex-wrap items-center gap-1.5">{#each parts as part, index (index)}{#if index}<span class="sr-only">,&nbsp;</span>{/if}<Badge variant="outline" class={prominent ? 'text-base' : undefined}>{part}</Badge>{/each}{@render children?.()}</span>{:else}{@render children?.()}{/if}
