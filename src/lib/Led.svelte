<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';

	// A brand variation of Badge. Only the visual digits use the LED font; the complete
	// localized meaning remains ordinary text in the accessibility tree.
	let { value, label, red = false, size = 'default', class: className }: {
		value: string;
		label: string;
		red?: boolean;
		size?: 'default' | 'small' | 'step' | 'display';
		class?: string;
	} = $props();
	const ghost = $derived(value.replace(/\d/g, '8'));
	const sizes = {
		default: 'px-3 py-2 text-[clamp(1.125rem,1rem+0.5vw,1.5rem)]',
		small: 'px-2 py-1 text-lg',
		step: 'h-18 w-14 p-0 text-[2.6rem] md:h-21 md:w-16 md:text-[3.1rem]',
		display: 'px-6 py-4 text-[clamp(3rem,14vw,5rem)] tracking-[0.08em]'
	};
</script>

<Badge variant="outline" class={cn('relative inline-grid place-items-center gap-0 rounded-sm border-border bg-[var(--led-cell)] font-[family-name:var(--font-led)] font-normal leading-none shadow-[inset_0_0_0_1px_var(--led-off)]', red ? 'text-[var(--led-red)]' : 'text-[var(--led-green)]', sizes[size], className)}>
	<span class="col-start-1 row-start-1 text-[var(--led-off)]" aria-hidden="true">{ghost}</span>
	<span class="col-start-1 row-start-1 [text-shadow:0_0_0.35em_currentColor]" aria-hidden="true">{value}</span>
	<span class="sr-only">{label}</span>
</Badge>
