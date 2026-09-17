<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import CheckoutReferences from '$lib/CheckoutReferences.svelte';
	import { getI18n } from '$lib/i18n';
	import { getCartContext, type CartState } from '$lib/cart';
	let { state }: { state: CartState } = $props();
	const i18n = getI18n();
	const m = $derived(i18n.m.cart);
	const cart = getCartContext();
	const failed = $derived(state.status === 'unavailable' || state.status === 'invalid');
</script>

<div class={['grid justify-items-start gap-3', (failed || state.activeAttempt) && 'my-4']}>
	<!-- The live region exists from first render so later state changes announce. -->
	<div class="grid w-full gap-3" aria-live="polite">
		{#if state.status === 'unavailable'}
			<Alert.Message role={undefined} appearance="inline" variant="destructive">{m.storage}</Alert.Message>
		{:else if state.status === 'invalid'}
			<Alert.Message role={undefined} appearance="inline" variant="destructive">{m.invalid}</Alert.Message>
		{/if}
		{#if state.activeAttempt}
			<Alert.Root role={undefined} variant="warning" class="gap-3">
				<Alert.Title>{m.locked}</Alert.Title>
				<Alert.Description>{m.recovery}</Alert.Description>
				<CheckoutReferences checkoutId={state.activeAttempt.checkoutId} requestId={state.activeAttempt.requestId} />
			</Alert.Root>
		{/if}
	</div>
	{#if failed}<Button variant="outline" type="button" onclick={() => cart.refresh()}>{m.retry}</Button>{/if}
</div>
