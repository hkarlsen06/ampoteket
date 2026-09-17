# Component illustrations

`static/components/*.webp` holds 13 transparent, cartoon-style 3D category
illustrations, generated with an image-generation tool and served as-is (nothing
runs at build time). `CategoryGraphic.svelte` maps category names to files and falls
back to `miscellaneous.webp`.

The TO-220 MOSFET (`transistors`) was generated first and used as the style
reference for the rest. The shared prompt asked for chunky toy-like geometry, broad
flat colour planes, bold dark contour lines and a clear silhouette on a transparent
5:3 canvas, and excluded photographic rendering, realistic materials, gradients,
textures, text, logos, cards, shadows and backgrounds. Each shows a familiar family
shape, not an exact product for sale.

Post-processing with Pillow: crop to visible bounds, fit within 240 × 144, set alpha
below 16 to zero (so the dark-mode CSS outline follows the component, not faint
background pixels), save as lossless transparent WebP.
