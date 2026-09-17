# Ampoteket brand assets

Designer source files, renamed from the designer's folder (`ampoteket_logo`); no
artwork changed. Spec sheets from that folder (size comparisons, old versions) were
not copied.

| File here | Original source | Role |
|---|---|---|
| `wordmark-metal-flat.svg` | `Flat Logo/SVG/Logo2DBluishMetal.svg` | Flat bluish-metal plate + red/green LEDs |
| `wordmark-2d.svg` | `Flat Logo/SVG/AMPOTEKET LOGO 2D.svg` | Alternate flat wordmark |
| `wordmark-3d-bluish.svg` | `3d Logo/SVG/LOGO_3D_BluishPlate_NoBacklight_squre.svg` | 3D alternate, no backlight |
| `mark-square.svg` | `Flat Logo/SVG/Square_Logo.svg` | Square `A` mark on metal |
| `square-grayplate.svg` | `Flat Logo/SVG/LOGO_2D_GrayPlate_square.svg` | Square gray-plate variant |
| `mark-circle.svg` | `Circle Logo/SVG/AMPOTEKET LOGO CIRCLE.svg` | Round `A` mark |
| `wordmark-oslomet.svg` | `Forenklet OsloMet stil/Logo ampoteket oslomet stil.svg` | Formal/print: black grotesk + OsloMet yellow dash |
| `wordmark-2d-outlined.pdf` | `Flat Logo/PDF/Logo2D.pdf` | Letters converted to paths |

## What the website serves

The SVGs are Inkscape working files whose letters are live text in a
**"Seven Segment"** font we do not have; served as-is they render in a serif
fallback. So `static/brand/` serves the designer's PNG renders:

| Output | Made from | Used for |
|---|---|---|
| `wordmark-flat.png` (756×139) | Largest instance in `Simplified Flat Logo/Simplified_Flat.png` (a size sheet with no SVG original), black plate removed (alpha = colour coverage un-premultiplied), trimmed to the letters | Header wordmark |
| `mark-square-512/180/64.png` | `Square Logo/Square Logo.png` (6400×6400), Lanczos downscale | App icon, `apple-touch-icon` (180), favicon (64) and footer mark. No SVG favicon |
| `wordmark-metal-flat.png` (2939×1158) | `Flat Logo/PNG/Logo2DBluishPlate.png`, unchanged | Not currently shown |

`wordmark-flat.png`'s red is `#FF3C33`, the dark theme's primary and LED red. The
light theme's `#C63933` primary matches it after the header's contrast filter.

An experimental script that outlined the letters from `wordmark-2d-outlined.pdf`
did not match the PNGs closely enough and was removed; it is in git history.

Still wanted from the designer: SVG exports with text converted to paths, and a
single-colour (white/black) mark for footer, receipts and engraving.
