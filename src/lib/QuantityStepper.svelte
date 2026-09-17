<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Separator } from '$lib/components/ui/separator';
	// Joined −/value/+ control for exact-string quantities. Presentation only:
	// the owner supplies the exact step arithmetic through `onstep`, so no
	// float or rounding can sneak in here.
	let {
		id,
		value = $bindable(),
		disabled = false,
		invalid = false,
		inputLabel,
		describedby,
		decreaseLabel,
		increaseLabel,
		onstep,
		oninput,
		onblur
	}: {
		id: string;
		value: string;
		disabled?: boolean;
		invalid?: boolean;
		inputLabel?: string;
		describedby?: string;
		decreaseLabel: string;
		increaseLabel: string;
		onstep: (direction: 1 | -1) => void;
		oninput?: (value: string) => void;
		onblur?: () => void;
	} = $props();
	let input = $state<HTMLInputElement | null>(null);
	// Allow scrolling and pinch zoom, but not double-tap zoom on repeated steps.
	const stepButtonClass = 'touch-manipulation h-full min-h-11 w-12 rounded-none border-0';

	export function focus() {
		input?.focus();
	}
</script>

<InputGroup.Root class="w-full max-w-72" data-disabled={disabled || undefined}>
	<InputGroup.Addon align="inline-start" class="relative h-full shrink-0 p-0 has-[>button]:ml-0">
		<InputGroup.Button size="icon" class={[stepButtonClass, 'rounded-s-lg']} type="button" aria-label={decreaseLabel} {disabled} onclick={() => onstep(-1)}>
			<Icon icon={MinusIcon} class="size-5" aria-hidden="true" />
		</InputGroup.Button>
		<Separator orientation="vertical" class="pointer-events-none absolute inset-y-0 right-0 bg-input" />
	</InputGroup.Addon>
	<InputGroup.Input
		bind:ref={input}
		bind:value
		{id}
		class="min-w-0 px-1 text-center font-mono"
		type="text"
		inputmode="decimal"
		autocomplete="off"
		autocapitalize="off"
		enterkeyhint="done"
		aria-label={inputLabel}
		aria-invalid={invalid || undefined}
		aria-describedby={describedby}
		{disabled}
		oninput={(event) => oninput?.(event.currentTarget.value)}
		{onblur}
	/>
	<InputGroup.Addon align="inline-end" class="relative h-full shrink-0 p-0 has-[>button]:mr-0">
		<Separator orientation="vertical" class="pointer-events-none absolute inset-y-0 left-0 bg-input" />
		<InputGroup.Button size="icon" class={[stepButtonClass, 'rounded-e-lg']} type="button" aria-label={increaseLabel} {disabled} onclick={() => onstep(1)}>
			<Icon icon={PlusIcon} class="size-5" aria-hidden="true" />
		</InputGroup.Button>
	</InputGroup.Addon>
</InputGroup.Root>
