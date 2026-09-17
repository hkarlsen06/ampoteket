/** Run against the local dev server: bun scripts/home-printer-proof.ts */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { ModelViewerElement } from '@google/model-viewer';

const browser = await chromium.launch();
const origin = process.env.AUDIT_ORIGIN ?? 'http://localhost:5174';
const artifacts = 'test-results/home-printer';
await mkdir(artifacts, { recursive: true });
// Mirrors the homepage printer poses (degrees): scroll moves azimuth/polar from start to end.
const START = { theta: 30, phi: 62 }, END = { theta: -25, phi: 90 }, TURN = 30, TILT = 15;
const at = (progress: number) => ({ theta: START.theta + (END.theta - START.theta) * progress, phi: START.phi + (END.phi - START.phi) * progress });
const clamp = (value: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), value));
const rest = at(0.5);

try {
	for (const width of [360, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
		const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		// Both locales render the same geometry; exercise their accessible descriptions too.
		await page.goto(`${origin}${colorScheme === 'dark' ? '/en' : ''}`);
		const viewer = page.locator('model-viewer#home-printer');
		// The viewer and its GLB load only when the models are about a screen away.
		await page.waitForLoadState('networkidle');
		const printer = page.locator('img[src="/models/bambu-p2s.webp"], model-viewer#home-printer');
		// The desktop layout can already place the equipment inside the preload margin.
		if (await printer.evaluate(element => element.getBoundingClientRect().top > innerHeight * 2)) {
			await expect(viewer).toHaveCount(0);
		}
		await printer.scrollIntoViewIfNeeded();
		await viewer.waitFor();
		await viewer.scrollIntoViewIfNeeded();
		await page.waitForFunction(() => document.querySelector<ModelViewerElement>('model-viewer#home-printer')?.loaded);
		await expect(page.getByRole('img', { name: /Bambu Lab P2S/ })).toHaveCount(1);
		const model = await viewer.evaluate(element => {
			const model = element as ModelViewerElement;
			return {
				meshes: model.originalGltfJson?.meshes?.length, dimensions: model.getDimensions(), materials: model.model?.materials.length,
				display: model.originalGltfJson?.materials?.filter(material => material.name?.startsWith('LCD ') && !material.name.includes('glass'))
			};
		});
		assert.ok(model.meshes && model.meshes > 1 && model.materials && model.materials > 1, 'A real GLB with meshes and materials must load');
		assert.ok(model.display?.length && model.display.every(material => material.extensions?.KHR_materials_unlit), 'Display artwork must remain unlit in the compressed GLB');
		assert.ok([model.dimensions.x, model.dimensions.y, model.dimensions.z].every(value => value > 0.1), 'The printer must have volume on all three axes');
		const stage = viewer.locator('..');
		const { start, end, x, width: stageWidth, height } = await stage.evaluate(element => {
			const box = element.getBoundingClientRect();
			const top = box.top + scrollY;
			return { start: top - innerHeight, end: top + box.height, x: box.x, width: box.width, height: box.height };
		});
		// A decreasing camera theta produces a counterclockwise model turn viewed from above,
		// while a rising phi lowers the camera to eye level.
		// Check clamping, intermediate rendered positions, and scrolling back up.
		for (const progress of [-0.1, 0, 0.125, 0.25, 0.5, 0.75, 0.875, 1, 1.1, 0.75, 0.5, 0.25, 0]) {
			const pose = at(Math.max(0, Math.min(1, progress)));
			await page.evaluate(y => scrollTo(0, y), start + (end - start) * progress);
			await page.waitForFunction(({ theta, phi }) => {
				const [azimuth, polar] = (document.querySelector<ModelViewerElement>('model-viewer#home-printer')?.getAttribute('camera-orbit') ?? '').split(' ').map(parseFloat);
				return Math.abs(azimuth - theta) < 0.2 && Math.abs(polar - phi) < 0.2;
			}, pose);
			if (progress > 0 && progress < 1) {
				await page.waitForFunction(({ theta, phi }) => {
					const orbit = document.querySelector<ModelViewerElement>('model-viewer#home-printer')?.getCameraOrbit();
					return orbit !== undefined && Math.abs(orbit.theta * 180 / Math.PI - theta) < 0.3 && Math.abs(orbit.phi * 180 / Math.PI - phi) < 0.3;
				}, pose);
			}
		}

		await page.evaluate(y => scrollTo(0, y), (start + end) / 2);
		await page.waitForFunction(theta => Math.abs(document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit().theta * 180 / Math.PI - theta) < 0.3, rest.theta);
		const hit = await viewer.evaluate(element => {
			const box = element.getBoundingClientRect();
			return (element as ModelViewerElement).materialFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.name;
		});
		assert.ok(hit, 'A ray through the browser view must hit rendered mesh geometry');
		const hoverBox = (await stage.boundingBox())!;
		for (const [name, pointerX, pointerY, theta, phi] of [
			['right', 0.95, 0.5, rest.theta - 0.9 * TURN, rest.phi], ['left', 0.05, 0.5, rest.theta + 0.9 * TURN, rest.phi],
			['top', 0.5, 0.05, rest.theta, rest.phi + 0.9 * TILT], ['bottom', 0.5, 0.95, rest.theta, rest.phi - 0.9 * TILT]
		] as const) {
			await page.mouse.move(hoverBox.x + hoverBox.width * pointerX, hoverBox.y + hoverBox.height * pointerY);
			await page.waitForFunction(({ theta, phi }) => {
				const orbit = document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit();
				return Math.abs(orbit.theta * 180 / Math.PI - theta) < 0.3 && Math.abs(orbit.phi * 180 / Math.PI - phi) < 0.3;
			}, { theta: clamp(theta, START.theta, END.theta), phi: clamp(phi, START.phi, END.phi) });
			await viewer.screenshot({ path: `${artifacts}/${width}-${colorScheme}-pointer-${name}.png` });
		}
		// A stronger hover response must still respect the scroll envelope.
		for (const [progress, pointerX, theta] of [[0.1, 0.05, START.theta], [0.9, 0.95, END.theta]]) {
			await page.mouse.move(0, 0);
			await page.evaluate(y => scrollTo(0, y), start + (end - start) * progress);
			const box = (await stage.boundingBox())!;
			await page.mouse.move(box.x + box.width * pointerX, Math.max(80, box.y + 16));
			await page.waitForFunction(expected => Math.abs(document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit().theta * 180 / Math.PI - expected) < 0.15, theta);
		}
		await page.mouse.move(0, 0);
		await page.evaluate(y => scrollTo(0, y), (start + end) / 2);
		await page.waitForFunction(({ theta, phi }) => {
			const orbit = document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit();
			return Math.abs(orbit.theta * 180 / Math.PI - theta) < 0.3 && Math.abs(orbit.phi * 180 / Math.PI - phi) < 0.3;
		}, rest);
		const restOrbit = await viewer.getAttribute('camera-orbit');
		await viewer.dispatchEvent('pointermove', { pointerType: 'touch', clientX: hoverBox.x, clientY: hoverBox.y });
		assert.equal(await viewer.getAttribute('camera-orbit'), restOrbit, 'Touch movement must not tilt the printer');
		await page.screenshot({ path: `${artifacts}/${width}-${colorScheme}-page.png` });
		const renders = new Set<string>();
		// Endpoints fall outside the viewport during scrolling. Center the actual viewer
		// and pose the same bounded angles for unobstructed reference comparison shots.
		for (const angle of [START.theta, rest.theta, END.theta]) {
			await viewer.evaluate((element, angle) => {
				const orbit = element.getAttribute('camera-orbit')!.split(' ');
				orbit[0] = `${angle}deg`;
				element.setAttribute('camera-orbit', orbit.join(' '));
			}, angle);
			await page.waitForFunction(expected => Math.abs(document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit().theta * 180 / Math.PI - expected) < 0.1, angle);
			await viewer.screenshot({ path: `${artifacts}/${width}-${colorScheme}-${angle}.png` });
			renders.add(await viewer.evaluate(element => (element as ModelViewerElement).toDataURL()));
		}
		assert.equal(renders.size, 3, 'Different camera angles must produce different WebGL pixels');
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
		const before = await stage.boundingBox();
		assert.ok(before && before.x === x && before.width === stageWidth && before.height === height, 'Scroll and rendering must preserve stage geometry');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(viewer).toHaveCount(0);
		const still = page.locator('img[src="/models/bambu-p2s.webp"]');
		await expect(still).toBeVisible();
		await still.evaluate(image => (image as HTMLImageElement).decode());
		assert.deepEqual(await still.locator('..').boundingBox(), before, 'Switching to the still must not move the stage');
		await page.screenshot({ path: `${artifacts}/${width}-${colorScheme}-reduced-motion.png` });
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.waitForFunction(() => document.querySelector<ModelViewerElement>('model-viewer#home-printer')?.loaded);
		await page.waitForFunction(theta => Math.abs(document.querySelector<ModelViewerElement>('model-viewer#home-printer')!.getCameraOrbit().theta * 180 / Math.PI - theta) < 0.3, rest.theta);
		assert.deepEqual(errors, []);
		await page.close();
	}

	for (const options of [{ reducedMotion: 'reduce' as const }, { javaScriptEnabled: false }]) {
		const context = await browser.newContext({ ...options, viewport: { width: 360, height: 900 } });
		const fallback = await context.newPage();
		await fallback.goto(origin);
		assert.equal(await fallback.locator('model-viewer#home-printer').count(), 0);
		const still = fallback.locator('img[src="/models/bambu-p2s.webp"]');
		await still.scrollIntoViewIfNeeded();
		await still.evaluate(image => (image as HTMLImageElement).decode());
		assert.ok(await still.evaluate(image => (image as HTMLImageElement).naturalWidth > 0));
		assert.equal(await fallback.getByRole('img', { name: /Bambu Lab P2S/ }).count(), 1);
		await fallback.screenshot({ path: `${artifacts}/${options.javaScriptEnabled === false ? 'no-js' : 'initial-reduced-motion'}.png` });
		await context.close();
	}
	console.log(`PASS: desktop/mobile GLB rendering, bounded counterclockwise turn with downward tilt and reversal, 30°/15° mouse-follow direction/clamping/reset with touch ignored, both colour schemes/locales, stable stage, live reduced-motion and no-JS fallbacks. Screenshots: ${artifacts}`);
} finally {
	await browser.close();
}
