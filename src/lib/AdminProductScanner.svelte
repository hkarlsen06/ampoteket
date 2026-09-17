<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import Icon from '$lib/Icon.svelte';
	import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import CameraFrame from '$lib/CameraFrame.svelte';
	import { productCodeFromQr } from '$lib/scanner/payload';
	import type { CameraSession, CameraState } from '$lib/scanner/session';

	// Finds a scanned label among the loaded staff products and hands its id to the page.
	let { products, disabled = false, onproduct }: {
		products: { id: string; code: string }[] | null; disabled?: boolean; onproduct: (productId: string) => void;
	} = $props();
	const i18n = getI18n(); const m = $derived(i18n.m.adminProducts);
	let scanOpen = $state(false); let cameraState = $state<CameraState>('closed'); let scanResult = $state<'idle' | 'invalid' | 'missing'>('idle'); let scannedCode = $state('');
	let video: HTMLVideoElement | undefined = $state(); let canvas: HTMLCanvasElement | undefined = $state();
	let cameraSession: CameraSession | null = null; let cameraOperation = 0; let alive = true;
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
		scanOpen = true; scanResult = 'idle'; scannedCode = ''; cameraState = 'starting';
		cameraSession?.stop();
		const current = ++cameraOperation;
		await tick();
		try {
			const { CameraSession } = await import('$lib/scanner/session');
			if (!alive || !scanOpen || current !== cameraOperation || !video || !canvas) return;
			cameraSession = new CameraSession(video, canvas, {
				state: (next) => { if (current === cameraOperation) cameraState = next; },
				duplicate: () => {},
				scan: (payload) => {
					if (current !== cameraOperation) return;
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
	function scanAgain() { scanResult = 'idle'; scannedCode = ''; cameraSession?.rearm(); cameraSession?.resume(); }
</script>

<Dialog.Root open={scanOpen} onOpenChange={(open) => { if (open) void startScanner(); else closeScanner(); }}>
	<Dialog.Trigger>{#snippet child({ props })}<Button {...props} variant="outline" disabled={!products || disabled} class="no-js:hidden"><Icon icon={QrCodeIcon} />{m.scanProduct}</Button>{/snippet}</Dialog.Trigger>
	<Dialog.Content preventScroll={false} aria-describedby={undefined} class="w-[26rem] max-w-[calc(100%-2rem)] gap-0 p-0">
		<Dialog.Header layout="bar">
			<Dialog.Title>{m.scanProduct}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{i18n.m.scanner.close}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<div class="grid justify-items-start gap-4 px-4 py-5 md:px-6">
		<CameraFrame bind:video bind:canvas />
		<p class="min-h-6 text-sm text-muted-foreground" role="status">{cameraState === 'starting' ? i18n.m.scanner.camera.starting : cameraState === 'scanning' ? '' : m.scanCameraUnavailable}</p>
		{#if !['starting', 'scanning'].includes(cameraState)}<Button type="button" variant="outline" onclick={startScanner}>{i18n.m.scanner.retryCamera}</Button>{/if}
		{#if scanResult === 'invalid'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanInvalid}</Alert.Message>{/if}
		{#if scanResult === 'missing'}<Alert.Message appearance="inline" variant="destructive" role="status">{m.scanMissing(scannedCode)}</Alert.Message>{/if}
		{#if scanResult !== 'idle'}<Button type="button" variant="outline" onclick={scanAgain}>{m.scanAgain}</Button>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
