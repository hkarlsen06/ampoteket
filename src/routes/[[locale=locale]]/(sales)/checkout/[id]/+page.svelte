<script lang="ts">
	import CheckoutPage from '#lib/CheckoutPage.svelte';
	import { page } from '$app/state';
</script>

<CheckoutPage checkoutId={page.params.id} />
