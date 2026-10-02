<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/Icon.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import MinusCircleIcon from 'phosphor-svelte/lib/MinusCircleIcon';
	import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
	import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon';

	// One operational state (open/closed, active/inactive, …): the word, a shape
	// and a colour, never the colour alone. Stock uses StockBadge instead.
	type Tone = 'success' | 'neutral' | 'warning' | 'destructive';
	let { tone = 'neutral', class: className, children }: { tone?: Tone; class?: string; children: Snippet } = $props();

	const icons = { success: CheckCircleIcon, neutral: MinusCircleIcon, warning: WarningIcon, destructive: XCircleIcon };
	const variants = { success: 'success', neutral: 'outline', warning: 'warning', destructive: 'destructive' } as const;
</script>

<Badge variant={variants[tone]} class={className}><Icon icon={icons[tone]} />{@render children()}</Badge>
