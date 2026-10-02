<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { sheetBody } from '#lib/ui.js';
	import Icon from '#lib/Icon.svelte';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import CameraFrame from '#lib/CameraFrame.svelte';
	import { productCodeFromQr } from '#lib/scanner/payload.js';
	import type { CameraSession, CameraState } from '#lib/scanner/session.js';

	// Finds a scanned label among the loaded staff products and hands its id to the page.
	let { products, disabled = false, onproduct }: {
		products: { id: string; code: string }[] | null; disabled?: boolean; onproduct: (productId: string) => void;
	} = $props();
	const i18n = getI18n(); const m = $derived(i18n.m.adminProducts);
	const admin = getAdminContext(); const uid = $props.id();
	let scanOpen = $state(false); let cameraState = $state<CameraState>('closed'); let scanResult = $state<'idle' | 'invalid' | 'missing'>('idle'); let scannedCode = $state('');
	let video: HTMLVideoElement | undefined = $state(); let canvas: HTMLCanvasElement | undefined = $state();
	let cameraSession: CameraSession | null = null; let cameraOperation = 0; let alive = true;
	$effect(() => { if (admin.status !== 'ready') interruptScanner(); });
	onMount(() => {
		const visibility = () => { if (document.hidden) interruptScanner(); };
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('pagehide', interruptScanner);
		return () => { alive = false; closeScanner(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', interruptScanner); };
	});
	function closeScanner() {
		cameraOperation++; cameraSession?.stop(); cameraSession = null;
		scanOpen = false; cameraState = 'closed'; scanResult = 'idle'; scannedCode = '';
	}
	function interruptScanner() {
		if (!scanOpen) return;
		cameraOperation++; cameraSession?.interrupt(); cameraState = 'interrupted';
	}
	async function startScanner() {
		if (disabled || !products || admin.status !== 'ready') return;
		scanOpen = true; scanResult = 'idle'; scannedCode = ''; cameraState = 'starting';
		cameraSession?.stop();
		const current = ++cameraOperation;
		await tick();
		try {
			const { CameraSession } = await import('#lib/scanner/session.js');
			if (!alive || !scanOpen || current !== cameraOperation || admin.status !== 'ready' || !video || !canvas) return;
			cameraSession = new CameraSession(video, canvas, {
				state: (next) => { if (current === cameraOperation) cameraState = next; },
				duplicate: () => {},
				scan: (payload) => {
					if (current !== cameraOperation || admin.status !== 'ready') return;
					cameraSession?.pause();
					const code = productCodeFromQr(payload);
					if (!code) { scanResult = 'invalid'; return; }
					const product = products?.find((item) => item.code === code);
					if (!product) { scannedCode = code; scanResult = 'missing'; return; }
					closeScanner();
					onproduct(product.id);
				}
			});
			await cameraSession.start();
		} catch { if (current === cameraOperation) cameraState = 'decoder'; }
	}
	function scanAgain() { if (disabled || admin.status !== 'ready') return; scanResult = 'idle'; scannedCode = ''; cameraSession?.rearm(); cameraSession?.resume(); }
</script>

<Dialog.Root open={scanOpen} onOpenChange={(open) => { if (open) void startScanner(); else closeScanner(); }}>
	<Dialog.Trigger>{#snippet child({ props })}<Button {...props} variant="outline" disabled={!products || disabled || admin.status !== 'ready'} class="no-js:hidden"><Icon icon={QrCodeIcon} />{m.scanProduct}</Button>{/snippet}</Dialog.Trigger>
	<Dialog.Content preventScroll={false} aria-describedby={undefined} class="w-[26rem] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
		<Dialog.Header layout="bar">
			<Dialog.Title id={`${uid}-title`}>{m.scanProduct}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{i18n.m.scanner.close}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll region supports native keyboard scrolling.) -->
		<div class={[sheetBody, 'grid auto-rows-max justify-items-start gap-4']} role="region" aria-labelledby={`${uid}-title`} tabindex="0">
		<AdminAccessGate>
		<CameraFrame bind:video bind:canvas />
		<p class="min-h-6 text-sm text-muted-foreground" role="status">{cameraState === 'starting' ? i18n.m.scanner.camera.starting : cameraState === 'scanning' ? '' : m.scanCameraUnavailable}</p>
		{#if scanResult === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanInvalid}</Alert.Message>{/if}
		{#if scanResult === 'missing'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanMissing(scannedCode)}</Alert.Message>{/if}
		</AdminAccessGate>
		</div>
		{#if !['starting', 'scanning'].includes(cameraState) || scanResult !== 'idle'}
		<Dialog.Footer variant="sheet">
			{#if !['starting', 'scanning'].includes(cameraState)}<Button type="button" variant="outline" disabled={admin.status !== 'ready'} onclick={startScanner}>{i18n.m.scanner.retryCamera}</Button>{/if}
			{#if scanResult !== 'idle'}<Button type="button" variant="outline" disabled={admin.status !== 'ready'} onclick={scanAgain}>{m.scanAgain}</Button>{/if}
		</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
