# Ampoteket brand assets

Designer source files. The "Original source" column gives each file's path in the
designer's `ampoteket_logo` folder; that folder's spec sheets (size comparisons, old
versions) are not part of this one.

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

## The Seven Segment font

The SVGs are Inkscape working files whose letters are live text in
[**Seven Segment** by Krafti Lab](https://www.dafont.com/seven-segment.font),
committed here as `SevenSegment.ttf` (install it to edit the SVGs; without it they
render in a serif fallback).

The font is free for personal use; Krafti Lab sells a commercial licence, which
Ampoteket has not bought. We use it with attribution and will remove it if the
rights holder asks (`static/fonts/SevenSegment-NOTICE.txt`). Removing it means
deleting the TTF and the LED webfont and returning `--font-led` to a free font; the
outlined `wordmark.svg` would need a decision of its own.

Before serving any of these SVGs, turn the text into paths:

```bash
python3 scripts/outline-brand-text.py assets/brand/SevenSegment.ttf assets/brand/IN.svg OUT.svg
bunx svgo@4 --multipass -p 2 OUT.svg   # strips Inkscape data and hidden layers
```

`scripts/build-led-font.py` builds the LED webfont from the TTF: digits and
`. - :` only, with every digit widened to the advance of `8` and set flush right,
so values line up with the `Led` component's ghost `8` cells.

## What the website serves

| Output | Made from | Used for |
|---|---|---|
| `wordmark.svg` (5.6 KB) | The lit segments (faces and highlight lines) of `wordmark-metal-flat.svg` after outlining, each letter moved to its place in the designer's `Simplified Flat Logo/Simplified_Flat.png` (a PNG-only design: the same glyphs at plate-free spacing), coloured as that PNG | Header wordmark |
| `wordmark-light.svg` | `wordmark.svg` with only the fills changed to the light theme's tokens: red faces `#C63933` (`--primary`), red highlights `#A8231C` (`--primary-ink`), green LED `#1B6A31` (`--green`), all opaque | Header and error-page wordmark under `prefers-color-scheme: light`, swapped by `<picture><source media>`, no CSS filter |
| `wordmark-email.png` (2 KB) | `wordmark.svg` rendered at 360×66 inside a 432×112 black sign (Firefox screenshot), quantized to 16 colours; re-render when the SVG changes | Auth email header (`supabase/templates/`). Gmail and Outlook do not display SVG, and the black is baked in because Gmail's dark mode inverts backgrounds but not images |
| `../fonts/SevenSegment-led.woff2` (2 KB) | `SevenSegment.ttf` via `scripts/build-led-font.py` | `Led` digits (`--font-led`) |
| `mark-square-180/64.png` | `Square Logo/Square Logo.png` (6400×6400), Lanczos downscale | `apple-touch-icon` (180), favicon (64) and footer/admin mark. No SVG favicon. `static/favicon.ico` (16–64 px) is generated from the 64 px PNG for clients that request `/favicon.ico` |

`wordmark.svg` is the source for the header wordmark; edit it directly. Its red
is `#FF3C33` at 84 % opacity, the dark theme's primary and LED red. Keep
`wordmark-light.svg` in step: same geometry, only the `fill` values differ.

The square mark is served as PNG: `mark-square.svg` is an earlier revision (larger
`A` box, wide dash box) than the served `Square Logo.png`, and no SVG of the current
revision exists.

Open requests to the designer: an SVG of the current `Square Logo`, and a
single-colour (white/black) mark for footer, receipts and engraving.
