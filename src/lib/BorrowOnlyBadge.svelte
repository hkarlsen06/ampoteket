<script lang="ts">
	import Icon from '#lib/Icon.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import HandshakeIcon from 'phosphor-svelte/lib/HandshakeIcon';
	import { getI18n } from '#lib/i18n/index.js';

	// Stands where a price would: a borrow-only product has none and can't be bought.
	let { prominent = false }: { prominent?: boolean } = $props();
	const i18n = getI18n();
</script>

<Badge class={prominent ? 'gap-2 rounded-md px-3 py-1.5 text-xl font-semibold [&>svg]:size-6!' : 'text-base font-semibold [&>svg]:size-4.5!'}><Icon icon={HandshakeIcon} />{i18n.m.shop.borrowOnly}</Badge>
