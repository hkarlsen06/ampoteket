import { BufferAttribute, type Mesh } from 'three';
import type { ModelViewerElement } from '@google/model-viewer';
import type { ModelScene } from '@google/model-viewer/lib/three-components/ModelScene.js';

export function createSolderingPointer(viewer: ModelViewerElement) {
	// model-viewer 4.3.1 is pinned: its public API cannot rotate an individual node.
	// Keep this private-scene access here; home-soldering-proof checks the contract.
	const key = Object.getOwnPropertySymbols(viewer).find(key => key.description === 'scene');
	const scene = key && (viewer as unknown as Record<symbol, ModelScene>)[key];
	const root = scene?.model;
	const tip = root?.getObjectByName('IronTipPivot');
	const pivot = root?.getObjectByName('IronPointerPivot');
	const cable = root?.getObjectByName('Flexible_iron_lead') as Mesh | undefined;
	if (!root || !tip || !pivot || !cable?.isMesh || !cable.geometry?.attributes.uv) return null;
	const original = cable.geometry;
	const geometry = cable.geometry = original.clone();
	// The compressed GLB stores positions quantized and interleaved. Bent vertices
	// can leave the quantized range, so the clone deforms plain float positions.
	const quantized = original.attributes.position;
	const base = new Float32Array(quantized.count * 3);
	for (let i = 0; i < quantized.count; i++) base.set([quantized.getX(i), quantized.getY(i), quantized.getZ(i)], i * 3);
	const position = new BufferAttribute(base.slice(), 3);
	geometry.setAttribute('position', position);
	const uv = geometry.attributes.uv;
	const point = tip.position.clone(), moved = point.clone();
	const delta = tip.matrixWorld.clone(), inverse = delta.clone();

	return {
		update(pointerX: number, pointerY: number, progress: number) {
			const withdrawal = Math.max(0, Math.min(1, (progress - .12) / .25));
			const influence = withdrawal * withdrawal * (3 - 2 * withdrawal);
			pivot.rotation.set(pointerY * 12 * Math.PI / 180 * influence, 0, pointerX * 25 * Math.PI / 180 * influence);
			root.updateWorldMatrix(true, true);
			delta.copy(cable.matrixWorld).invert().multiply(tip.matrixWorld).multiply(pivot.matrix)
				.multiply(inverse.copy(tip.matrixWorld).invert()).multiply(cable.matrixWorld);
			position.array.set(base);
			for (let i = 0; i < position.count; i++) {
				const tail = Math.max(0, Math.min(1, (uv.getX(i) - .72) / .28));
				if (!tail) continue;
				cable.getVertexPosition(i, point);
				moved.copy(point).applyMatrix4(delta).sub(point).multiplyScalar(tail * tail * (3 - 2 * tail));
				position.setXYZ(i, base[i * 3] + moved.x, base[i * 3 + 1] + moved.y, base[i * 3 + 2] + moved.z);
			}
			// Known limit: modest bends reuse the cable's morph normals; rebake for larger turns.
			position.needsUpdate = true;
		},
		dispose() {
			cable.geometry = original;
			geometry.dispose();
		}
	};
}
