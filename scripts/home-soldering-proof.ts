/** Run against the local dev server: bun scripts/home-soldering-proof.ts */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { ModelViewerElement } from '@google/model-viewer';
import { en } from '../src/lib/i18n/en';
import { nb } from '../src/lib/i18n/nb';

const origin = process.env.AUDIT_ORIGIN ?? 'http://localhost:5174';
const artifacts = 'test-results/home-soldering';
const selector = 'model-viewer#home-soldering';
const stillSelector = 'img[src="/models/soldering-station.webp"]';
type Point = { clone(): Point; toArray(): number[]; distanceTo(point: Point): number; project(camera: unknown): Point; applyMatrix4(matrix: unknown): Point };
type SceneNode = {
	position: Point;
	matrixWorld: { elements: number[] };
	getObjectByName(name: string): SceneNode | undefined;
	getWorldPosition(point: Point): Point;
	updateWorldMatrix(parents: boolean, children: boolean): void;
};
type Cable = SceneNode & {
	geometry: { attributes: { uv: { count: number; getX(index: number): number } } };
	getVertexPosition(index: number, point: Point): Point;
};
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch();

try {
	for (const width of [360, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
		const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		const messages = colorScheme === 'dark' ? en : nb;
		await page.goto(`${origin}${colorScheme === 'dark' ? '/en' : ''}`);
		const viewer = page.locator(selector);
		await page.locator(stillSelector).scrollIntoViewIfNeeded();
		await viewer.waitFor();
		await viewer.scrollIntoViewIfNeeded();
		await page.waitForFunction(selector => document.querySelector<ModelViewerElement>(selector)?.loaded, selector);
		await expect(page.getByRole('img', { name: messages.home.facilities.solderingAlt, exact: true })).toHaveCount(1);
		const model = await viewer.evaluate(element => {
			const viewer = element as ModelViewerElement;
			return { animations: viewer.availableAnimations, duration: viewer.duration, meshes: viewer.originalGltfJson?.meshes?.length,
				materials: viewer.model?.materials.length, dimensions: viewer.getDimensions(), paused: viewer.paused };
		});
		assert.ok(model.animations.includes('Soldering') && Math.abs(model.duration - 4) < .1, 'The exported four-second Soldering clip must load');
		assert.ok(model.meshes && model.meshes > 1 && model.materials && model.materials > 1, 'The browser must load real 3D meshes and materials');
		assert.ok([model.dimensions.x, model.dimensions.y, model.dimensions.z].every(size => size > .05));
		assert.equal(model.paused, true, 'The clip must not autoplay');
		const stage = viewer.locator('..');
		const initial = await stage.evaluate(element => {
			const box = element.getBoundingClientRect();
			return { top: box.top + scrollY, x: box.x, width: box.width, height: box.height,
				start: box.top + scrollY + box.height / 2 - innerHeight * 1.1,
				end: box.top + scrollY + box.height / 2 - innerHeight * .35 };
		});
		// Inspect the live rendered node transforms, not merely the requested animation time.
		// Named pivots and longitudinal cable UVs are the exported animation contract.
		const pose = () => viewer.evaluate(element => {
			const symbol = Object.getOwnPropertySymbols(element).find(key => key.description === 'scene');
			if (!symbol) throw new Error('model-viewer scene unavailable');
			const scene = (element as unknown as Record<symbol, { model: SceneNode; camera: unknown }>)[symbol];
			const root = scene.model;
			root.updateWorldMatrix(true, true);
			const tip = root.getObjectByName('IronTipPivot');
			const target = root.getObjectByName('SolderContactTarget');
			const socket = root.getObjectByName('IronCableSocket');
			const station = root.getObjectByName('Station_and_board_\u2014_Black_moulded_enclosure');
			const cable = root.getObjectByName('Flexible_iron_lead') as Cable | undefined;
			if (!tip || !target || !socket || !station || !cable) throw new Error('Iron/station/cable nodes missing from the GLB');
			const tipPosition = tip.getWorldPosition(tip.position.clone());
			const targetPosition = target.getWorldPosition(target.position.clone());
			const socketPosition = socket.getWorldPosition(socket.position.clone());
			const endpoint = [0, 0, 0], point = socket.position.clone();
			let count = 0;
			for (let i = 0; i < cable.geometry.attributes.uv.count; i++) {
				if (cable.geometry.attributes.uv.getX(i) < .99999) continue;
				const vertex = cable.getVertexPosition(i, point).applyMatrix4(cable.matrixWorld).toArray();
				vertex.forEach((value, axis) => endpoint[axis] += value);
				count++;
			}
			if (!count) throw new Error('Cable handle endpoint UVs missing');
			const socketCoordinates = socketPosition.toArray();
			return { tip: tipPosition.toArray(), target: targetPosition.toArray(), distance: tipPosition.distanceTo(targetPosition),
				socket: socketCoordinates, projected: socketPosition.clone().project(scene.camera).toArray(),
				station: [...station.matrixWorld.elements],
				cableGap: Math.hypot(...endpoint.map((value, axis) => value / count - socketCoordinates[axis])) };
		});
		const poses: Awaited<ReturnType<typeof pose>>[] = [];
		const pixels = new Set<string>();
		for (const progress of [-.1, 0, .25, .5, .75, 1, 1.1, .75, .5, .25, 0]) {
			await page.evaluate(y => scrollTo(0, y), initial.start + (initial.end - initial.start) * progress);
			const expected = Math.max(0, Math.min(1, progress)) * (model.duration - .000001);
			await page.waitForFunction(({ selector, expected }) => {
				const viewer = document.querySelector<ModelViewerElement>(selector)!;
				return viewer.paused && Math.abs(viewer.currentTime - expected) < .015;
			}, { selector, expected });
			if (progress >= 0 && progress <= 1 && poses.length < 5) {
				poses.push(await pose());
				const tag = `${width}-${colorScheme}-${progress}`;
				await page.screenshot({ path: `${artifacts}/${tag}-page.png` });
				const png = await viewer.evaluate(element => (element as ModelViewerElement).toDataURL());
				pixels.add(png);
				await writeFile(`${artifacts}/${tag}.png`, Buffer.from(png.split(',')[1], 'base64'));
			}
		}
		assert.ok(poses[0].distance > .05, 'The iron starts away from the circuit board');
		assert.ok(Math.max(...poses.slice(1, 4).map(pose => pose.tip[1])) > poses[0].tip[1] + .015, 'The tip must lift clear of its holder');
		assert.ok(poses[4].distance < .002, `The tip must touch the board pad (gap ${poses[4].distance}m)`);
		const returned = await pose();
		assert.ok(returned.tip.every((value, axis) => Math.abs(value - poses[0].tip[axis]) < .00001), 'Reverse scrolling must return the iron to its holder');
		assert.ok(pixels.size >= 4, 'Scroll must produce distinct rendered poses');
		const stopped = await viewer.evaluate(element => (element as ModelViewerElement).currentTime);
		await page.waitForTimeout(300);
		assert.equal(await viewer.evaluate(element => (element as ModelViewerElement).currentTime), stopped, 'No scroll means no animation');
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
		const docked = await pose();
		const dockBox = (await stage.boundingBox())!;
		await page.mouse.move(dockBox.x + dockBox.width * .9, dockBox.y + dockBox.height / 2);
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		assert.deepEqual((await pose()).socket, docked.socket, 'Pointer tilt stays disabled while the iron is seated');
		await page.mouse.move(0, 0);
		for (const progress of [.5, 1]) {
			await page.evaluate(y => scrollTo(0, y), initial.start + (initial.end - initial.start) * progress);
			await page.waitForFunction(({ selector, expected }) => Math.abs(document.querySelector<ModelViewerElement>(selector)!.currentTime - expected) < .015,
				{ selector, expected: progress * (model.duration - .000001) });
			const neutral = await pose();
			const orbit = await viewer.evaluate(element => (element as ModelViewerElement).getCameraOrbit());
			const box = (await stage.boundingBox())!;
			for (const [name, x, y, axis, direction] of [
				['right', .9, .5, 0, 1], ['left', .1, .5, 0, -1],
				['top', .5, .1, 1, 1], ['bottom', .5, .9, 1, -1]
			] as const) {
				await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
				await expect.poll(async () => ((await pose()).projected[axis] - neutral.projected[axis]) * direction,
					{ message: `Iron handle must follow the mouse ${name} in screen space` }).toBeGreaterThan(.008);
				const tilted = await pose();
				assert.ok(tilted.tip.every((value, axis) => Math.abs(value - neutral.tip[axis]) < .000001), 'Hover must keep the working tip anchored');
				assert.deepEqual(tilted.target, neutral.target, 'Hover must leave the board fixed');
				assert.deepEqual(tilted.station, neutral.station, 'Hover must leave the station fixed');
				assert.deepEqual(await viewer.evaluate(element => (element as ModelViewerElement).getCameraOrbit()), orbit, 'Hover must leave the camera fixed');
				assert.ok(tilted.cableGap < .001, `Cable must remain connected to the grip (${tilted.cableGap}m gap)`);
				await viewer.screenshot({ path: `${artifacts}/${width}-${colorScheme}-${progress}-pointer-${name}.png` });
			}
			await page.mouse.move(0, 0);
			await expect.poll(async () => Math.hypot(...(await pose()).socket.map((value, axis) => value - neutral.socket[axis]))).toBeLessThan(.000001);
			await viewer.dispatchEvent('pointermove', { pointerType: 'touch', clientX: box.x, clientY: box.y });
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			assert.deepEqual((await pose()).socket, neutral.socket, 'Touch must not tilt the iron');
		}

		// Restore a visible contact pose before changing the live motion preference.
		await page.evaluate(y => scrollTo(0, y), initial.end);
		await page.waitForFunction(selector => document.querySelector<ModelViewerElement>(selector)!.currentTime > 3.98, selector);
		const before = (await stage.boundingBox())!;
		assert.ok(before.x === initial.x && before.width === initial.width && before.height === initial.height, 'Animation must retain stage geometry');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(viewer).toHaveCount(0);
		const still = page.locator(stillSelector);
		await expect(still).toBeVisible();
		await still.evaluate(image => (image as HTMLImageElement).decode());
		assert.deepEqual(await still.locator('..').boundingBox(), before, 'The static fallback must retain stage geometry');
		await page.screenshot({ path: `${artifacts}/${width}-${colorScheme}-reduced-motion.png` });
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.waitForFunction(selector => document.querySelector<ModelViewerElement>(selector)?.loaded, selector);
		await page.waitForFunction(selector => document.querySelector<ModelViewerElement>(selector)!.currentTime > 3.98, selector);
		assert.ok((await pose()).distance < .002, 'Restoring animation must recover the current scroll pose');
		assert.deepEqual(errors, []);
		await page.close();
	}

	for (const mode of ['reduced-motion', 'no-js', 'load-error'] as const) {
		const context = await browser.newContext({ viewport: { width: 360, height: 900 },
			reducedMotion: mode === 'reduced-motion' ? 'reduce' : 'no-preference', javaScriptEnabled: mode !== 'no-js' });
		if (mode === 'load-error') await context.route('**/models/soldering-station.glb.gz', route => route.abort());
		const page = await context.newPage();
		const failed = mode === 'load-error' ? page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/models/soldering-station.glb.gz') }) : null;
		await page.goto(origin);
		await page.locator(`${selector}, ${stillSelector}`).scrollIntoViewIfNeeded();
		if (failed) await failed;
		await expect(page.locator(selector)).toHaveCount(0);
		const still = page.locator(stillSelector);
		await still.evaluate(image => (image as HTMLImageElement).decode());
		assert.ok(await still.evaluate(image => (image as HTMLImageElement).naturalWidth > 0));
		await expect(page.getByRole('img', { name: nb.home.facilities.solderingAlt, exact: true })).toHaveCount(1);
		await page.screenshot({ path: `${artifacts}/${mode}.png` });
		await context.close();
	}
	console.log(`PASS: desktop/mobile real GLB animation, lift/contact/reversal, iron follows mouse with anchored tip and connected cable, fixed station/camera, static/error fallbacks. Screenshots: ${artifacts}`);
} finally {
	await browser.close();
}
