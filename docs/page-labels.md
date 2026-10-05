# Product labels

`/admin/products/labels` generates A4 PDF sheets of drawer labels. It is staff-only and
read-only; printing never changes stock or publication. Selection is
`src/lib/LabelShelfSelection.svelte` (shared with the [catalog](page-catalog.md)
filter), rendering `src/lib/labels/render.ts`, the P-touch driver
`src/lib/labels/ptouch.ts`.

## Selection and data

The shelf diagram is the only selector. A cabinet's checkbox toggles all its drawers;
tapping the cabinet zooms in. Partial cabinets show a mixed state. Shift-click or
Shift+Space applies the new state to the range from the previous anchor in reading
order (highest row first, left to right), within one cabinet for drawers. The short
Shift hint appears only with a fine pointer.

Cabinets retain enough width for their checkbox and coordinate. Dense walls pan
inside a named, keyboard-accessible region without widening the page. Focus and
returning from a cabinet reveal its controls within that region.

- **Select all** includes every live drawer and products without a drawer.
- Each saved product in a selected drawer gets exactly one label, including unpublished
  products and zero or negative stock. Empty drawers and archived storage add nothing.
- The page says unpublished products must be published before buyers can find them.
- Reads are complete staff reads with the operator's JWT. A missing or failed page
  blocks export, never an empty result. Generation re-reads current data; the preview
  is the export snapshot.
- Background revalidation keeps controls stable; generation waits for an ongoing
  read before starting. One live region announces selection and generation results.
  Once the PDF is ready, **Download A4 PDF** is the primary action.

## Label and sheet

Each label is **code → QR → short specifications**. The QR encodes only
`ampoteket.no/p/<code>`, regardless of locale or origin. The scanner accepts this and
older `https://` labels. Some phone cameras may show a scheme-less address as text.

- Width is the only setting (32–81 mm, default 45 mm); geometry scales with it. Cut
  guides form one shared grid through the gutters.
- The specification is the first saved field in category order. A number with a unit
  prints alone («10 kΩ»); other values keep their name («Polarisert: Nei»).
- Text is never truncated or shrunk; labels grow to fit and rows use the tallest label.
  Overflow and missing glyphs are reported per product.
- The QR has a two-module side border, not the standard four, and modules of at least
  0.35 mm. At most 2,000 labels and 100 copies per product per file.
- Previews use the PDF's exact vector paths; PDF text is outlined. Print at
  **100% / actual size**.
- Only Generate loads the engine: `zxing-wasm` 3.1.3 (same-origin WASM, SHA-256
  checked), `pdf-lib` 1.17.1, `@pdf-lib/fontkit` 1.1.1 and bundled Lato Regular 2.015
  (licence in `static/licenses/labels-font.txt`). No CDN or server endpoint.

## P-touch tape labels

**Print** in a saved product's editor prints its label on a Brother PT-P700 (USB
`04f9:2061`) over WebUSB, only in desktop Chromium browsers over HTTPS or localhost;
with a fine pointer; elsewhere the button is disabled with a visible reason. The first
print opens the device picker. Creating a
product with **Print label** checked prints its label as soon as it is saved. `prepareTapeLabel`
in `render.ts` draws the label.

- Same content as the sheet. Fixed geometry for the accepted 18 mm tape at 180 dpi:
  14-dot text, 4-dot (0.56 mm) modules, one blank module each side.
- Tape width comes from the printer status (printable dots: 18 mm → 112, 24 mm → 128).
  Tapes of 12 mm and narrower, and codes that do not fit, are rejected.
- Commands follow Brother's Raster Command Reference PT-H500/P700/E500 §2.1. Success
  waits for *printing completed*; no completion within 20 seconds is reported as
  unconfirmed, so the operator checks before retrying.
- **Chain printing.** The cutter sits 24.5 mm ahead of the head, so each label waits
  under it until the next print pushes it out; the printer's cut button feeds the last
  one. Only the first print after a cut or tape change wastes a leader. The success
  message says where the label is.

## Acceptance

`./scripts/test-web.sh --labels` exports a PDF from the real app and decodes its QR
codes (needs Python PyMuPDF). Physical acceptance: measure drawer label areas, print
an A4 sheet, check size and cut margins, attach it to real drawers and scan it in the
workshop's light. Results and open checks: [VALIDATION.md](../VALIDATION.md).
