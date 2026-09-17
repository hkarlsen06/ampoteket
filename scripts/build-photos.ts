// Web derivatives of the photograph masters in assets/photos (design system §6.1).
// Run from the repository root: bun scripts/build-photos.ts
// Writes static/photos/<name>-<width>.webp and the site-wide link preview card.
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';

const SOURCE = 'assets/photos';
const OUT = 'static/photos';
const WIDTHS = [960, 1280, 1920, 2560];

// Dark photographs compress far below the phone budget; the dense drawer wall
// needs a lower quality for its 1280 px phone variant to stay under 100 KB.
const PHOTOS = [
	{ name: 'storefront', file: 'IMG_0834-storefront-angle.png', quality: 72 },
	{ name: 'workshop', file: 'IMG_0825-workshop-at-night.png', quality: 72 },
	{ name: 'bench', file: 'IMG_0824-electronics-bench.png', quality: 72 },
	{ name: 'drawers', file: 'IMG_0827-component-drawers.png', quality: 58 }
];

const report = (path: string, width: number, height: number) =>
	console.log(`${path} ${width}×${height} ${Math.round(statSync(path).size / 1024)} KB`);

mkdirSync(OUT, { recursive: true });
for (const { name, file, quality } of PHOTOS) {
	for (const width of WIDTHS) {
		const path = `${OUT}/${name}-${width}.webp`;
		const { height } = await sharp(`${SOURCE}/${file}`)
			.resize({ width, withoutEnlargement: true })
			.toColourspace('srgb')
			.webp({ quality, effort: 6, smartSubsample: true })
			.toFile(path);
		report(path, width, height);
	}
}

// The window and its sign, cropped to the 1200 × 630 Open Graph card.
const card = `${OUT}/social-card.jpg`;
await sharp(`${SOURCE}/IMG_0834-storefront-angle.png`)
	.extract({ left: 430, top: 330, width: 2700, height: 1417 })
	.resize(1200, 630)
	.toColourspace('srgb')
	.jpeg({ quality: 82, mozjpeg: true })
	.toFile(card);
report(card, 1200, 630);
