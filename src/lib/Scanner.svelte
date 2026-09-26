<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import { AspectRatio } from '$lib/components/ui/aspect-ratio';
	import * as Item from '$lib/components/ui/item';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import { formActions } from '$lib/ui';
	import { onMount, tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { getI18n } from '$lib/i18n';
	import { lookupCatalogProduct, productName, type CatalogConfig, type CatalogProduct } from '$lib/catalog';
	import { productCodeFromEntry, productCodeFromQr } from '$lib/scanner/payload';
	import type { CameraSession, CameraState } from '$lib/scanner/session';
	import ProductIdentity from '$lib/ProductIdentity.svelte';
	import ProductPrice from '$lib/ProductPrice.svelte';
	import ProductAvailability from '$lib/ProductAvailability.svelte';
	import ProductPurchase from '$lib/ProductPurchase.svelte';
	import CartNotice from '$lib/CartNotice.svelte';
	import { getCartContext } from '$lib/cart';

	// One layout-owned buyer scanner: review quantities before adding on shopping pages.
	// Its own trigger floats on phones; above 40rem the header menu calls show().
	let { config }: { config: CatalogConfig | null } = $props();
	const id = $props.id();
	const i18n = getI18n();
	const cart = getCartContext();
	const m = $derived(i18n.m.scanner);
	let mounted = $state(false);
	let open = $state(false);
	let camera = $state<CameraState>('closed');
	let workflow = $state<'idle' | 'resolving' | 'product' | 'invalid' | 'missing' | 'unavailable' | 'adding'>('idle');
	let entry = $state('');
	let code = $state<string | null>(null);
	let allowCompactCode = false;
	let product = $state<CatalogProduct | null>(null);
	let frozen = $state(false);
	let duplicate = $state(false);
	let added = $state(false);
	let video: HTMLVideoElement | undefined = $state();
	let overlay: HTMLCanvasElement | undefined = $state();
	let closeControl = $state<HTMLButtonElement | null>(null);
	let session: CameraSession | null = null;
	let lookup: AbortController | null = null;
	let operation = 0;
	let cameraOperation = 0;
	const name = $derived(product ? productName(product, i18n.locale) : '');
	const entryCode = $derived(productCodeFromEntry(entry));
	const reviewing = $derived(workflow !== 'idle');
	const cameraFailed = $derived(!['closed', 'starting', 'scanning'].includes(camera));

	/** Opens the dialog from a trigger outside this component (the desktop header menu). */
	export function show() { if (mounted) void startCamera(); }
	function abortLookup() { operation += 1; lookup?.abort(); lookup = null; }
	function close() {
		cameraOperation += 1; session?.stop(); session = null;
		open = false; camera = 'closed'; duplicate = false;
		abortLookup(); workflow = 'idle'; product = null; frozen = false; added = false;
	}
	function interrupt() {
		if (!open) return;
		cameraOperation += 1; session?.interrupt(); camera = 'interrupted';
		if (workflow === 'resolving') { abortLookup(); workflow = 'unavailable'; }
	}
	beforeNavigate(close);
	onMount(() => {
		mounted = true;
		const visibility = () => { if (document.hidden) interrupt(); };
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('pagehide', interrupt);
		return () => {
			mounted = false; close();
			document.removeEventListener('visibilitychange', visibility);
			window.removeEventListener('pagehide', interrupt);
		};
	});

	async function startCamera() {
		if (camera === 'starting') return;
		open = true; camera = 'starting';
		const current = ++cameraOperation;
		await tick();
		try {
			const { CameraSession } = await import('$lib/scanner/session');
			if (!mounted || current !== cameraOperation || !video || !overlay) return;
			session ??= new CameraSession(video, overlay, {
				state: (next) => { camera = next; },
				duplicate: (blocked) => { duplicate = blocked; },
				scan: (payload) => {
					if (workflow !== 'idle') return;
					// Session acceptance is already closed synchronously.
					frozen = true; void resolve(productCodeFromQr(payload));
				}
			});
			if (workflow === 'idle') session.resume(); else session.pause();
			await session.start();
		} catch { if (current === cameraOperation) camera = 'decoder'; }
	}

	async function resolve(nextCode: string | null, compact = false) {
		if (workflow === 'adding') return;
		session?.pause(); abortLookup();
		code = nextCode; allowCompactCode = compact; product = null; added = false;
		if (!code) { workflow = 'invalid'; return; }
		workflow = 'resolving';
		if (!config) { workflow = 'unavailable'; return; }
		const current = operation;
		const controller = lookup = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 15000);
		try {
			const found = await lookupCatalogProduct(config, code, { signal: controller.signal, allowCompactCode });
			if (!mounted || current !== operation) return;
			product = found;
			workflow = found ? 'product' : 'missing';
		} catch { if (mounted && current === operation) workflow = 'unavailable'; }
		finally { clearTimeout(deadline); if (lookup === controller) lookup = null; }
	}
	function manual(event: SubmitEvent) {
		event.preventDefault();
		if (!mounted || workflow === 'adding' || !entryCode) return;
		frozen = false; void resolve(entryCode, productCodeFromQr(entry.trim()) === null);
	}
	function resume(returnFocus = document.activeElement?.matches('.scanner-dialog :focus-visible') ?? false) {
		if (workflow === 'adding') return;
		abortLookup(); workflow = 'idle'; product = null; frozen = false;
		session?.resume();
		// Keyboard activation removes its confirmation control. Restore a stable
		// control without scrolling or summoning the phone's software keyboard.
		if (returnFocus) void tick().then(() => { if (mounted) closeControl?.focus({ preventScroll: true }); });
	}
</script>

<div class="scanner contents" data-state={workflow} data-camera={camera}>
	<Dialog.Root {open} onOpenChange={(next) => { if (next) void startCamera(); else close(); }}>
		<Dialog.Trigger disabled={!mounted}>
			{#snippet child({ props })}
				<Button {...props} aria-label={m.open} class="scanner-trigger hidden shrink-0 px-3 no-js:hidden phone:fixed phone:inline-flex phone:right-[max(1rem,env(safe-area-inset-right))] phone:bottom-[calc(1rem+env(safe-area-inset-bottom))] phone:px-5 phone:shadow-card">
					<Icon icon={QrCodeIcon} />{m.action}
				</Button>
			{/snippet}
		</Dialog.Trigger>
		<Dialog.Content
			class="scanner-dialog max-h-[calc(100dvh-2rem)] w-[26rem] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 text-base break-words"
			preventScroll={false}
			showCloseButton={false}
			aria-describedby={undefined}
			onEscapeKeydown={(event) => { if (workflow === 'adding') event.preventDefault(); }}
			onInteractOutside={(event) => { if (workflow === 'adding') event.preventDefault(); }}>

			<Dialog.Header layout="bar" density="compact">
				<Dialog.Title>{m.title}</Dialog.Title>
				<Button variant="ghost" bind:ref={closeControl} class="shrink-0" size="icon" type="button" disabled={workflow === 'adding'} onclick={close} aria-label={m.close}><Icon icon={XIcon} class="size-5" aria-hidden="true" /></Button>
			</Dialog.Header>
			<!-- Keep the compact viewfinder within the 360×640 confirmation budget. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (named keyboard-scrollable fallback) -->
			<div class="dialog-body grid auto-rows-max gap-2 overflow-y-auto overscroll-contain px-4 pt-3 pb-4" role="region" tabindex="0" aria-label={m.contents}>
				<!-- A found product takes the top row, its frozen frame shrunk to the right. -->
				<div class="flex items-center gap-3">
					{#if product}
						<!-- One sans-name/mono-figure cluster; the total below is the one large figure. -->
						<Item.Root variant="row" class="grid min-w-0 flex-1 gap-1 p-0">
							<ProductIdentity {product} headingLevel={3} compact showChevron />
							<ProductPrice {product} compact />
							<ProductAvailability {product} inline />
						</Item.Root>
					{/if}
					<div class={['viewfinder', product ? 'w-24 shrink-0' : 'mx-auto w-[min(100%,16dvh,12rem)]']}>
						<AspectRatio ratio={1} class="bg-secondary">
						<!-- Camera imagery has no audio; equivalent part identity follows as text. -->
						<video class="scanner-video absolute inset-0 size-full object-cover" bind:this={video} autoplay muted playsinline aria-label={m.preview}></video>
						<canvas class={['scanner-freeze absolute inset-0 size-full object-cover', frozen ? 'visible' : 'invisible']} bind:this={overlay} aria-hidden="true"></canvas>
						<div class="pointer-events-none absolute inset-[10%] border-[3px] border-[var(--paper)] outline-2 outline-[var(--ink)]" aria-hidden="true"></div>
						</AspectRatio>
					</div>
				</div>
				<!-- Beside a product the status is usually empty, so it only holds space when the camera fails. -->
				<Field.Description class={['m-0 leading-[1.55] text-foreground', product && !cameraFailed ? 'sr-only' : 'min-h-6']} role="status">{workflow === 'resolving' ? m.resolving : added ? i18n.m.product.added : m.camera[camera]} {#if camera === 'scanning'}{#if reviewing}<span class="sr-only">{m.paused}</span>{:else if duplicate}{m.moveAway}{/if}{/if}</Field.Description>
				{#if cameraFailed || (duplicate && workflow === 'idle')}
					<div class={formActions}>
						{#if cameraFailed}<Button variant="outline" type="button" onclick={startCamera}>{m.retryCamera}</Button>{/if}
						{#if duplicate && workflow === 'idle'}<Button variant="outline" type="button" onclick={() => session?.rearm()}>{m.again}</Button>{/if}
					</div>
				{/if}
				<div class="scanner-result grid gap-2">
					<Field.Description class={['m-0 text-base leading-[1.55] text-foreground empty:hidden', (workflow === 'product' || workflow === 'adding') && 'sr-only']} role="status">{#if workflow === 'invalid'}{m.invalid}{:else if workflow === 'missing'}{m.missing}{:else if workflow === 'unavailable'}{m.unavailable}{:else if workflow === 'product'}<span class="sr-only">{m.found(name)}</span>{/if}</Field.Description>
					{#if product}
						<CartNotice state={$cart} />
					{:else if reviewing && workflow !== 'resolving'}
						<div class={formActions}>
							{#if workflow === 'unavailable' && code}<Button variant="outline" type="button" onclick={() => resolve(code, allowCompactCode)}>{m.retryLookup}</Button>{/if}
							<Button variant="ghost" type="button" onclick={() => resume()}>{m.cancel}</Button>
						</div>
					{/if}
					{#if !product}
						<form class="manual mt-1 grid gap-2" aria-busy={workflow === 'resolving'} onsubmit={manual}>
							<Field.Label for={`${id}-entry`}>{m.entry}</Field.Label>
							<div class={formActions}>
								<Input id={`${id}-entry`} class="min-w-0 flex-[1_1_10rem] font-mono" type="text" bind:value={entry} maxlength={128} autocomplete="off" autocapitalize="characters" inputmode="text" enterkeyhint="search" spellcheck="false" disabled={!mounted || workflow === 'adding'} />
								<Button type={workflow === 'resolving' ? 'button' : 'submit'} disabled={!mounted || workflow === 'adding' || (workflow !== 'resolving' && !entryCode)} onclick={(event) => { if (workflow === 'resolving') { event.preventDefault(); resume(); } }}><ButtonLabel label={m.find} pendingLabel={m.cancel} pending={workflow === 'resolving'} /></Button>
							</div>
						</form>
					{/if}
				</div>
			</div>
			{#if product}
				<Dialog.Footer variant="sheet" class="block px-4 py-3">
					<ProductPurchase {product} compact showCartNotice={false}
						onpending={(pending) => { if (open && product) workflow = pending ? 'adding' : 'product'; }}
						onadded={(returnFocus) => { if (open && product) { resume(returnFocus); added = true; } }}
						onscan={() => resume()} />
				</Dialog.Footer>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
</div>
