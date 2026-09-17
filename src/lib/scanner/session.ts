import { createQrDecoder, type QrDecoder } from './decoder';
import { ScanGate } from './selection';

export type CameraState = 'closed' | 'starting' | 'scanning' | 'denied' | 'unavailable' | 'interrupted' | 'decoder';
type Callbacks = { state: (state: CameraState) => void; scan: (payload: string) => void; duplicate: (blocked: boolean) => void };

/** Client-only camera ownership. Pause changes acceptance/decoding, not tracks.
 * Stop invalidates late startup/frame promises and releases every resource.
 * Product resolution and basket operations belong to the calling UI. */
export class CameraSession {
	private generation = 0;
	private stream: MediaStream | null = null;
	private decoder: QrDecoder | null = null;
	private controller: AbortController | null = null;
	private animation = 0;
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private sample = document.createElement('canvas');
	private gate = new ScanGate();
	private lastSampleAt = 0;
	private lastVideoTime = -1;
	private lastFrameAt = 0;
	private decoding = false;
	private decodeEpoch = 0;
	private trackListeners: (() => void)[] = [];
	constructor(private video: HTMLVideoElement, private frozen: HTMLCanvasElement, private callbacks: Callbacks) {}

	async start() {
		this.stop();
		const generation = this.generation;
		const controller = this.controller = new AbortController();
		this.callbacks.state('starting');
		if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			this.callbacks.state('unavailable'); return;
		}
		try {
			// Start permission request directly from the user's activation. A closed
			// or superseded request may still resolve: stop its tracks immediately.
			const camera = navigator.mediaDevices.getUserMedia({ audio: false, video: {
				facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }
			} }).then((stream) => {
				if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Cancelled camera'); }
				this.stream = stream;
				for (const track of stream.getVideoTracks()) {
					const interrupted = () => this.interrupt();
					track.addEventListener('ended', interrupted); track.addEventListener('mute', interrupted);
					this.trackListeners.push(() => { track.removeEventListener('ended', interrupted); track.removeEventListener('mute', interrupted); });
				}
				return stream;
			});
			const decoding = createQrDecoder(controller.signal).then((decoder) => {
				if (generation !== this.generation) { decoder.dispose(); throw new Error('Cancelled decoder'); }
				this.decoder = decoder;
			}).catch((error) => {
				if (generation === this.generation) { this.stop(); this.callbacks.state('decoder'); }
				throw error;
			});
			const [stream] = await Promise.all([camera, decoding]);
			if (generation !== this.generation) return;
			this.video.srcObject = stream;
			await this.video.play();
			if (generation !== this.generation) return;
			this.lastVideoTime = -1; this.lastSampleAt = 0; this.lastFrameAt = performance.now();
			this.callbacks.state('scanning');
			// A live track can stall without an ended event on phone interruption.
			this.watchdog = setInterval(() => {
				if (this.gate.accepting && performance.now() - this.lastFrameAt > 10000) this.interrupt();
			}, 1000);
			this.schedule(generation);
		} catch (error) {
			if (generation !== this.generation) return;
			this.stop();
			this.callbacks.state(error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'denied' : 'unavailable');
		}
	}

	pause() { this.decodeEpoch += 1; this.gate.pause(); cancelAnimationFrame(this.animation); }
	resume() {
		this.gate.resume(); this.lastFrameAt = performance.now();
		this.callbacks.duplicate(this.gate.hasBlocked);
		if (this.stream && this.decoder && !this.decoding) this.schedule(this.generation);
	}
	rearm() { this.gate.rearm(); this.callbacks.duplicate(false); }
	interrupt() { this.stop(); this.callbacks.state('interrupted'); }
	stop() {
		this.generation += 1;
		cancelAnimationFrame(this.animation); clearInterval(this.watchdog); this.watchdog = undefined;
		this.controller?.abort(); this.controller = null;
		this.trackListeners.forEach((remove) => remove()); this.trackListeners = [];
		this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
		this.decoder?.dispose(); this.decoder = null;
		this.video.pause(); this.video.srcObject = null;
		this.decoding = false;
	}
	private schedule(generation: number) {
		cancelAnimationFrame(this.animation);
		if (!this.gate.accepting || generation !== this.generation) return;
		this.animation = requestAnimationFrame((now) => { void this.frame(generation, now); });
	}
	private async frame(generation: number, now: number) {
		if (!this.gate.accepting || generation !== this.generation || !this.decoder) return;
		const { videoWidth: width, videoHeight: height, currentTime } = this.video;
		if (!width || !height || this.video.readyState < 2 || currentTime === this.lastVideoTime || now - this.lastSampleAt < 120) {
			this.schedule(generation); return;
		}
		this.lastSampleAt = now; this.lastFrameAt = now; this.lastVideoTime = currentTime;
		const side = Math.min(width, height);
		// object-fit: cover in a square viewfinder; central 80% is the exact ROI.
		const pixels = Math.min(768, side);
		this.sample.width = pixels; this.sample.height = pixels;
		const context = this.sample.getContext('2d', { willReadFrequently: true });
		if (!context) { this.interrupt(); return; }
		this.decoding = true;
		const epoch = this.decodeEpoch;
		try {
			context.drawImage(this.video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, pixels, pixels);
			const inset = Math.round(pixels * 0.1);
			const results = await this.decoder.decode(context.getImageData(inset, inset, pixels - 2 * inset, pixels - 2 * inset));
			if (generation !== this.generation || epoch !== this.decodeEpoch || !this.gate.accepting) return;
			const accepted = this.gate.observe(results, performance.now());
			this.callbacks.duplicate(accepted.duplicate);
			if (accepted.value !== null) {
				// Copy the sampled frame: live video may have advanced during decode.
				this.frozen.width = pixels; this.frozen.height = pixels;
				const overlay = this.frozen.getContext('2d');
				if (!overlay) { this.interrupt(); return; }
				overlay.drawImage(this.sample, 0, 0);
				this.callbacks.scan(accepted.value);
			}
		} catch {
			if (generation === this.generation) { this.stop(); this.callbacks.state('decoder'); }
		} finally {
			if (generation === this.generation) { this.decoding = false; this.schedule(generation); }
		}
	}
}
