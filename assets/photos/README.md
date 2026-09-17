# Ampoteket workshop photographs

Photographs by Hjalmar Karlsen, supplied for Ampoteket marketing. The PNGs are
stored in Git LFS; run `git lfs pull` before rebuilding.

These are the four selected, edited photographs as full-resolution, lossless
**16-bit sRGB PNG** masters, rendered straight from the camera originals (no
resizing, no intermediate JPEG, GPS metadata omitted).

| File | Camera source | Dimensions |
|---|---|---|
| `IMG_0824-electronics-bench.png` | `IMG_0824.DNG` | 5483 × 4090 |
| `IMG_0825-workshop-at-night.png` | `IMG_0825.DNG` | 5425 × 3876 |
| `IMG_0827-component-drawers.png` | `IMG_0827.DNG` | 3418 × 2757 |
| `IMG_0834-storefront-angle.png` | `IMG_0834.JPG` | 4066 × 3100 |

In 0834 the surveillance camera and its mounting plate above the window were removed
with conventional clone retouching from nearby wall texture. No generative AI or
upscaling was used. Its JPG source keeps its original compression limits.

The originals and editing settings are kept by the photographer, outside this
repository.

## Rebuild the served derivatives

```sh
bun scripts/build-photos.ts
```

This writes `static/photos/`: WebP at 960/1280/1920/2560 px, plus the 1200 × 630
link-preview card cropped to the storefront window. How the photographs are shown
and credited: [design system §6.1](../../docs/design-system.md#61-photographs).
