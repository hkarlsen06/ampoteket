<script module lang="ts">
	// Creating a product remounts its editor on the product's own route; a label
	// requested with the save prints from there. Memory only, so reload never reprints,
	// and the product's editor clears it on leaving, so Back never does either.
	let queued: { productId: string; userId: string } | null = null;
	export function queueLabelPrint(job: { productId: string; userId: string } | null) { queued = job; }
</script>
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import Icon from '$lib/Icon.svelte';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { readProductAttributes, type AdminProduct, type ProductReferences } from '$lib/admin-products';
	import { labelSpecificationLines } from '$lib/labels/data';
	import { printTapeLabel, PtouchError } from '$lib/labels/ptouch';
	let { product, references }: { product: AdminProduct; references: ProductReferences } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	type Outcome = 'idle' | 'printed' | keyof typeof m.labelPrinter;
	let busy = $state(false); let outcome = $state<Outcome>('idle');
	// Prints the saved code and specifications. The printer is chosen first, while
	// the click still grants the browser's device-picker permission.
	async function print() {
		if (busy) return;
		busy = true; outcome = 'idle';
		const session = admin.credentials(); const locale = i18n.locale;
		try {
			await printTapeLabel(async pins => {
				const [{ prepareTapeLabel }, attributes] = await Promise.all([import('$lib/labels/render'), readProductAttributes(session, product.id)]);
				const lines = labelSpecificationLines({ products: [product], references, attributes }, product, locale, null);
				return prepareTapeLabel({ id: product.id, code: product.code, lines }, pins);
			});
			outcome = 'printed';
		} catch (error) {
			const kind = error instanceof PtouchError ? error.kind : null;
			outcome = kind === 'cancelled' ? 'idle' : kind ?? (error instanceof Error && error.name === 'LabelRenderError' && 'kind' in error && error.kind === 'overflow' ? 'fit' : 'failed');
			if (!kind) await admin.permissionFailure(error);
		} finally { busy = false; }
	}
	onMount(() => {
		const job = queued; queued = null;
		if (job?.productId === product.id && job.userId === admin.session?.user.id) void print();
	});
</script>
<!-- Two cells of the product editor's header grid: the button under the category
     illustration, and a full-width status row below the heading. -->
<Button variant="outline" class="col-start-2 h-auto flex-col gap-1 justify-self-center px-3 py-2" aria-label={m.printLabelName} disabled={busy} onclick={print}>
	<Icon icon={QrCodeIcon} class="size-6" /><ButtonLabel pending={busy} pendingLabel={m.printingLabel} label={m.printLabel} />
</Button>
<div class="col-span-full text-sm [&:not(:has(*))]:-mt-3" aria-live="polite">
	{#if outcome !== 'idle'}<Alert.Message appearance="inline" role={undefined} variant={outcome === 'printed' ? 'default' : 'destructive'}>{outcome === 'printed' ? m.labelPrinted : m.labelPrinter[outcome]}</Alert.Message>{/if}
</div>
