<script module lang="ts">
	import { printerSupported } from '#lib/labels/ptouch.js';
	export const labelPrinterSupported = () => printerSupported() && window.matchMedia('(pointer: fine)').matches;
	// Creating a product remounts its editor on the product's own route; a label
	// requested with the save prints from there. Memory only, so reload never reprints,
	// and the product's editor clears it on leaving, so Back never does either.
	let queued: { productId: string; userId: string } | null = null;
	export function queueLabelPrint(job: { productId: string; userId: string } | null) { queued = job; }
</script>
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { formStatus } from '#lib/ui.js';
	import Icon from '#lib/Icon.svelte';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readProductAttributes, type AdminProduct, type ProductReferences } from '#lib/admin-products.js';
	import { labelSpecificationLines } from '#lib/labels/data.js';
	import { printTapeLabel, PtouchError } from '#lib/labels/ptouch.js';
	// `describedby` names a shared unsupported notice, so a list of buttons shows it once.
	let { product, references, describedby }: { product: AdminProduct; references: ProductReferences; describedby?: string } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts); const uid = $props.id();
	type Outcome = 'idle' | 'printed' | keyof typeof m.labelPrinter;
	let busy = $state(false); let outcome = $state<Outcome>('idle');
	let supported = $state(false);
	// Prints the saved code and specifications. The printer is chosen first, while
	// the click still grants the browser's device-picker permission.
	async function print() {
		if (busy) return;
		busy = true; outcome = 'idle';
		const session = admin.credentials(); const locale = i18n.locale;
		try {
			await printTapeLabel(async pins => {
				const [{ prepareTapeLabel }, attributes] = await Promise.all([import('#lib/labels/render.js'), readProductAttributes(session, product.id)]);
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
		supported = labelPrinterSupported();
		const job = queued; queued = null;
		if (supported && job?.productId === product.id && job.userId === admin.session?.user.id) void print();
	});
</script>
<Button variant="outline" size="sm" aria-label={m.printLabelName} aria-describedby={!supported ? describedby ?? `${uid}-unsupported` : undefined} disabled={busy || !supported} onclick={print}>
	<Icon icon={QrCodeIcon} /><ButtonLabel pending={busy} pendingLabel={m.printingLabel} label={m.printLabel} />
</Button>
{#if !supported && !describedby}<p id={`${uid}-unsupported`} class="basis-full text-sm text-muted-foreground">{m.labelPrinter.unsupported}</p>{/if}
<div class={[formStatus, 'basis-full text-sm']} aria-live="polite">
	{#if outcome !== 'idle'}<Alert.Message appearance="inline" variant={outcome === 'printed' ? 'default' : 'destructive'}>{outcome === 'printed' ? m.labelPrinted : m.labelPrinter[outcome]}</Alert.Message>{/if}
</div>
