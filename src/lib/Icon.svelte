<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	let { icon: IconComponent, size = 24, ...props }: ComponentProps<typeof CheckIcon> & {
		icon: typeof CheckIcon;
	} = $props();
</script>

<IconComponent {size} role="presentation" aria-hidden="true" focusable="false" {...props} />
