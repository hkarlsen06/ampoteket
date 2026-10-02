<script lang="ts">
	import type { ClassValue } from 'svelte/elements';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { codeText } from '#lib/ui.js';
	import { getI18n } from '#lib/i18n/index.js';

	// One reference to give a volunteer; the request ID stays available for a
	// lost prepare response and for staff lookup.
	let { checkoutId, requestId, class: className }: { checkoutId?: string | null; requestId?: string | null; class?: ClassValue } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.cart);
</script>

<dl class={['m-0 grid content-start gap-x-6 gap-y-3', className]}>
	{#if checkoutId || requestId}
		<div class="min-w-0">
			<dt class="text-sm text-muted-foreground">{checkoutId ? m.checkoutReference : m.requestReference}</dt>
			<dd class="mt-1"><Badge variant="secondary" class={[codeText, 'select-all']}>{checkoutId ?? requestId}</Badge></dd>
		</div>
	{/if}
	{#if checkoutId && requestId}
		<div class="min-w-0 text-sm text-muted-foreground">
			<dt>{m.backupReference}</dt>
			<dd class={['mt-1 select-all', codeText]}>{requestId}</dd>
		</div>
	{/if}
</dl>
