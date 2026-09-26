# Ampoteket design system

Applies to every page under `ampoteket.no`. `src/app.css` owns theme tokens (with
their exact values), document typography and global accessibility rules;
`src/lib/components/ui/` owns the shared shadcn components. Routes and domain
components compose them with Tailwind utilities. The UI is bilingual; see
[i18n.md](i18n.md). Code, tokens and docs are English.

## 1. What the site should feel like

Ampoteket is a shelf in an electronics workshop with a small LED sign on it, not a
webshop template. Three principles decide most questions:

1. **Red is the brand colour.** The red seven-segment sign sits on dark metal; green
   is reserved for positive stock and other operational states. Everything else stays
   quiet.
2. **Fast and honest on bad wifi.** No webfonts except one 5 KB seven-segment face,
   no hero video, no carousels. Every number shown is a recorded balance and is
   labelled as such. Payment is trust-based and is never shown as confirmed.
3. **One thing per screen.** The landing page's job is to get a phone to the catalog
   or the scanner within one tap. Explanations come after the buttons.

## 2. Colour

**The theme follows the operating system.** Dark is the base; `@media
(prefers-color-scheme: light)` swaps the tokens for daylight. There is no toggle.
The `dark:` variant also follows the media query. Verify both schemes when you
change a token.

Exact values live in `src/app.css`; `@theme inline` maps them to utilities such as
`bg-card`, `text-muted-foreground` and `border-input`. Use the utility, never
`[var(--…)]`. Raw hex appears in `app.css` and nowhere else (plus the two
`theme-color` tags in `src/app.html`, §6).

| Token | Role |
|---|---|
| `--background`, `--card`/`--popover` | Page; header, footer, panels |
| `--secondary`/`--muted`/`--accent` | Secondary surfaces and hover. **`--muted` is a surface**; secondary text uses `--muted-foreground` |
| `--border`, `--input` | Hairlines; form-control outlines |
| `--foreground`, `--muted-foreground` | Body and secondary text (≥ 4.5:1 in both schemes) |
| `--primary` / `--primary-foreground` / `--primary-ink` | Primary actions only, in brand red; `--primary-ink` is the wireframe button's text |
| `--destructive` | Errors, «Tomt» |
| `--green` (`text-success`) | Positive state, «På lager» |
| `--yellow` (`bg-warning`) / `--on-yellow` | Warnings and the current-product shelf highlight; always black text on it |
| `--ring` / `--focus-contrast` | The two focus-ring layers (§5 Focus) |
| `--link` | Inline links |
| `--overlay`, `--shadow-card-color` | Dialog backdrop; `shadow-card` under floating surfaces |
| `--led-cell`, `--led-red`, `--led-green`, `--led-off` | LED cells (same in both schemes) |
| `--paper` / `--ink` | A depicted printed bin label |
| `--night`, `--night-*` | Scheme-stable black photograph stages and the text, borders, links and red accent on them |
| `--steel`, `--steel-seam`, `--drawer`, `--drawer-edge` | The shelf graphic's cabinet steel and drawer fronts |
| `--metal` | Plate behind the hero sign only |

`--bg`, `--text` and `--yellow` remain aliases for document rules, shelf
illustrations and brand artwork.

Rules:

- **Red and green never carry meaning alone.** Every state pairs colour with a word
  and, where there is room, a shape (dot, icon). Stock: «På lager» green, «Lite igjen»
  yellow, «Tomt» red, «Ukjent» grey (fetch error). Never render a fetch error as 0.
- **LED tokens only on black cells.** Status text uses `text-destructive` /
  `text-success`, which are tuned for page contrast.
- **Primary actions use brand red.** Green never implies that Vipps payment was verified.
- **Yellow is a signal, not a brand colour.** Focus uses link blue.

## 3. Typography

| Role | Face | Sizes (mobile → desktop) |
|---|---|---|
| Display headline | System sans 800, tracking −0.02em, line-height 1.02 | 2.5rem → 4.5rem (`clamp`) |
| Operational page / section heading | `pageHeading` / `sectionHeading` from `$lib/ui` | 1.875 → 2.25rem / 1.25 → 1.5rem |
| Section heading (h2) / sub-heading (h3) | System sans 700 / 650 | 1.5 → 2rem / 1.125 → 1.25rem |
| Body | System sans 400, line-height 1.55 | 1rem → 1.0625rem, max `--measure` |
| Section introduction | `lede` from `$lib/ui`, `text-muted-foreground` | 1.0625 → 1.125rem, max `--measure-lede` |
| Small | Same | 0.875rem, the minimum for content, including badges, chips and codes |
| Code / quantity / money | `font-mono` (system mono stack) | Fits the surrounding readout |
| LED figures | **Seven Segment** by Krafti Lab, the logo's font (`/fonts/SevenSegment-led.woff2`, 2 KB, preloaded; see [assets/brand/README.md](../assets/brand/README.md)) | Sized by the cell |

No webfont for text: on workshop wifi the page must paint on the first round trip.
The system and mono stacks cover æ ø å.

**Two measures, and only two.** `--measure` (62ch) for body prose, `--measure-lede`
(42ch) for the hero lede, section decks and fine print.

The LED font holds only digits and `. - :`. Use the `Led` component for display digits
(step numbers, recorded counts, the opening date). Its localized plain-text label
stays in the accessibility tree while the digit spans are `aria-hidden`. Never set
words in it, and never use a cell for a number the reader must act on if the font
fails to load.

Icons are Phosphor SVGs via `$lib/Icon.svelte`. Decorative icons are hidden from
assistive technology; icon-only controls keep localized accessible names.

## 4. Layout

- **Content width** 72rem, gutters 1.25rem (phone) / 2rem (≥ 48rem).
- **One tight radius scale** from `--radius` (2px): `sm`/`md`/`lg` for controls,
  chips, menus and tooltips; `xl` (4px) for cards, dialogs and photo frames. `default`,
  `outline` and `night` buttons are square. `rounded-full` only for inherently round
  parts (switch, radio, slider thumb, dots), never for buttons or badges. LED cells
  and bin stickers keep their brand geometry. No page-specific radii.
- **Vertical rhythm** in multiples of 0.5rem; sections separated by 4rem (phone) /
  6rem (desktop) of space, not by borders. Hairlines group inside a section.
- **Breakpoints**: 48rem (two columns), 64rem (full grid). Verify at 360, 768, 1280 px.
- **Touch targets** ≥ 44 × 44 px. Shelf-diagram cells are at least 24 × 24 px (WCAG
  2.2 target-size minimum) with spatial keyboard navigation; dense layouts pan inside
  the named shelf viewport (§4.2) rather than shrinking.
- **No nested cards.** `Card.Root` is an independent surface; nothing inside it gets
  another card or confirmation box. Borders mark real groupings, controls or LED cells.
- Controls keep their position through interaction; disclosure grows below its trigger.

### 4.1 Mobile first

The primary device is a phone held in one hand in front of the shelf, on bad wifi.
Every screen is **designed at 360 px first**; desktop is derived by giving elements
room. Page specs (`docs/page-*.md`) describe the phone layout first.

- **One DOM for all widths.** Adapt with CSS (media queries, `display: contents`,
  grid re-flow), never parallel component trees or rendering on measured window
  width. The header menu (§5) is the pattern to copy. The one exception is the admin
  `Sidebar`, whose upstream branch renders a modal sheet below 48rem; only navigation
  is replaced and the editor stays mounted.
- **Media queries** use `rem` and `min-width` (phone is the unprefixed base), only at
  48rem (`md:`) and 64rem (`lg:`), plus the one `max-width: 40rem` header collapse.
  Avoid `sm:` layout changes. A layout that needs another breakpoint is redesigned.
- **Forms use the horizontal space.** Never a plain stack of full-width fields with
  prose between them. Related fields share a wrapping row, every field is sized to
  its expected content (a coordinate needs ~6rem), and a control is a text input only
  when free text is the interaction: units are affixed inside the control, on/off is
  a switch, a short fixed choice is a segmented group, computed results are readouts.
  Exceptions: short single-task forms (sign-in, one lookup) keep one narrow column.
- **Wide data reflows; the page never scrolls sideways.** A desktop table becomes
  stacked rows or label/value pairs on the phone. Only named scroll regions (§4.2) pan.
- **Hover is decoration only.** Everything reachable by hover is equally available
  by tap and focus. `title` attributes never carry required information.
- **The primary action sits in the flow**, at the end of the content it concludes.
  The one exception is the buyer scanner trigger on home, catalog, product and cart
  at ≤ 40rem: a fixed bottom-right 48 px button inside the safe area, with bottom
  clearance reserved, hidden during text input and under dialogs (on home it starts
  docked in the hero). Above 40rem it is the first header-menu row; never show two.
  Checkout, help and admin have none. No other floating buttons or bottom bars.
- **The virtual keyboard is part of the layout.** Inputs are ≥ 1rem so iOS never
  zooms. Shared controls supply keyboard, capitalization, autocomplete and return-key
  defaults; native input types retain their keyboards. Override these for the field's
  purpose (codes: mono, `autocapitalize="characters"`; quantities:
  `inputmode="decimal"`). The focused field and its actions stay visible above the
  keyboard.

**Verify every UI change** at 360 and 1280 px, both colour schemes, both languages
(Norwegian runs long), with long product names; on the phone also with the keyboard
open on each form. Confirm zero horizontal page scroll and whole focus rings (§5).

### 4.2 Scrolling and viewport

Scrolling belongs to the browser. The site never re-implements, hijacks, animates
or suppresses it.

- **The document is the only scroll container.** Native scroll restoration, no
  `overflow: auto` page wrapper, no `100vh` app shell. `<body>` is `min-height: 100dvh`.
- **Interior scroll regions are rare, named exceptions.** Each has
  `overscroll-behavior: contain`, visible edges (scrollbar or fade), a keyboard tab
  stop with an accessible name, and keeps titles, close and primary/save actions
  outside it. The current ones:
  - `ShelfDiagram`'s viewport (arrow/Home/End pan it to reveal the focused cell;
    the document stays still);
  - `LabelShelfSelection`'s wall viewport, which preserves cabinet target and
    coordinate widths on dense walls and reveals keyboard focus locally;
  - the homepage shelf sheet's `shelf-picker-body` and the admin placement sheet's
    `shelf-editor-body`;
  - dialog bodies `count-body`, `placement-sheet-body`, `order-entry-body` and the
    planned receipt review, plus the new specification form, staff scanner and
    drawer rename bodies;
  - `AlertDialog.Description`, named by its confirmation title;
  - the catalog filter picker, and the scanner's last-resort overflow fallback;
  - the admin `Sidebar.Content` menu and the product combobox result list.
- **The header never hides.** `position: sticky; top: 0`, constant height
  (`--header-h`), never auto-hides, shrinks or transforms on scroll.
- **Scroll-linked motion is homepage-only**, driven by native document scroll,
  reversing with it, with a still fallback for reduced motion or no
  `animation-timeline` support. The complete list:
  - hero storefront walk-in (stage pins while the storefront grows into the room);
  - bench photograph power-on (switches on like a CRT);
  - P2S printer rotation, plus a hover-follow tilt within its range;
  - soldering-iron movement from holder to board, with the withdrawn iron following
    the mouse;
  - header scroll meter, a primary hairline filling along the header's bottom edge
    (`scroll-meter` in `app.css`), unlit without support, hidden for reduced motion.

  CSS lives in `app.css` (`scroll-motion:`/`walk-motion:` variants, `walk-*`/`power-on`).
  The homepage observer enables the walk only when the natural copy fits its CSS
  height budget; enlarged text otherwise retains the static layout. CSS owns the
  breakpoints and reduced-motion fallback;
  details in [page-home.md](page-home.md). Nothing else moves with scroll.
- **Anchors respect the header.** `scroll-padding-top` in `app.css` keeps anchors
  and focus targets below it. New sticky surfaces update the `--header-h` math.
- **Never scroll the user programmatically**, except the skip link, focus moving to
  `#main` after navigation, and focusing the first invalid field. No
  `scrollIntoView` choreography, no global `scroll-behavior: smooth`. The shelf
  viewport's keyboard pan and the homepage sheet's selection advancement are
  immediate widget moves, not document scrolling.
- **Nothing above the fold shifts while loading.** Images declare `width`/`height`.
  Async data renders into a box that already has its final size; a fetch error
  replaces the value in the same box («Ukjent» / “Unavailable”).
- **Loading is a replacement, not an extra row.** Keep loaded content mounted during
  refresh and replace it atomically; gate actions that need fresh data. Skeletons
  follow the result's shape. Do not narrate placeholders; keep accessible status
  announcements. Busy buttons reserve both labels with `ButtonLabel`.
- **The app owns routine freshness.** Refresh at the relevant lifecycle events and
  reconcile completed changes automatically; no refresh buttons. Keep content, input,
  selection and focus stable during background reads. A failed load shows an
  unavailable state with a contextual retry. Stock conflicts and deliberate
  mutations still confirm explicitly.
- **`scrollbar-gutter: stable`** on `html` so short and long pages do not shift sideways.
- **No scroll locking.** The phone header menu uses `Collapsible`; filters, scanner,
  sheets and the mobile admin sidebar use the shared `Dialog` with
  `preventScroll={false}`. Never change body overflow.
- **No horizontal page scroll at any width ≥ 320 px.** Fix overflow at its source
  (wrap, reflow, `overflow-wrap`), never with a global `overflow-x: hidden`.

### 4.3 Section rhythm

Sections open with a heading that names their content. No eyebrow labels above it,
no numbered section indices («01», «02») beside it, no italic accent words inside it.
Mono is for data (codes, quantities, money), never for labels or captions. Page
backgrounds are true black (dark) or white (light), never a tinted off-white.
Add an introductory paragraph only when it adds context beyond the heading and
content. A full-width band (`Separator` lines across the page, standard padding) may mark
an act on a long page; use one per page at most, and nothing inside it gets a second
surface.

**Empty secondary sections are not rendered.** A read-only history or archive
(archived cabinets and drawers, receipt and cancellation history, receipts without
an order, stock history) appears only once it has entries; an empty heading or
disclosure offers nothing to read or do. A page's primary list (catalog, cart,
orders, counts, audit) and a status answer («nothing needs attention») keep their
`Empty.Root`, because there "none" is the information.

## 5. Components and implementation

Components come from the official **shadcn-svelte Nova registry** (`components.json`),
with Bits UI for behaviour and Tailwind CSS 4. The copied `.svelte` files are
project-owned source; how to add or update them and the local adaptations to keep
are in [`src/lib/components/ui/README.md`](../src/lib/components/ui/README.md).

Import from `$lib/components/ui/<component>`; use Tailwind for layout. No local
`<style>` blocks and no `@layer components`; do not recreate retired global recipes
(`.btn`, `.input`, `.panel`, `.wrap`, `.section`, `.led`, …).

**`$lib/ui` recipes** centralize repeated presentation: `pageContainer` (wide,
admin and reading widths; `padding: 'page'`), `pageHeader`, `pageHeading`,
`sectionHeading`, `lede`, `itemTitle`, `codeText`, `nameWrap`, `cardLink`,
`formLayout`, `formGrid`, `formActions`, `formStatus`, `sheetBody` and `section`.
They are classes, not wrappers: keep semantic HTML at the call site.
`formStatus` collapses when it has no child elements, using `:has(*)` so whitespace
between conditional blocks does not leave an empty gap.
Extend a recipe when a presentation repeats; keep local geometry with its owner.

Prefer shared variants to repeated class overrides:

| Shared API | Use |
|---|---|
| `Field.Group layout="row"` | Wrapping, bottom-aligned related fields/actions |
| `Field.Field width="grow\|short\|medium"` | Names/notes, coordinates, quantities/prices; full width is default |
| `Item.Group` + `Item.Root variant="row"` + `Item.Separator` | Flat lists with one separator between rows |
| `Alert.Message`, `appearance="inline"`, `variant="warning"` | Text-only feedback; inline in the existing surface; attention without error |
| `Empty.Root` | Empty state with any recovery action; no icon |
| `Dialog.Header layout="bar"` | Title/close bar with a localized icon-only close |
| `Dialog.Content/Footer variant="sheet"` + `sheetBody` | Side sheet, its action row and named scrolling body |
| `Badge variant="success\|warning"`, `StateBadge` | Operational states: word + icon + colour |
| `DisclosureTrigger` | The one inline-disclosure trigger inside `Collapsible.Root` |

Domain components (`src/lib/*.svelte`) compose these primitives; they are not a
parallel UI library. Share product presentation through `ProductIdentity`,
`ProductPrice`, `ProductAvailability` and `ProductPurchase` instead of copying
markup. Domain data, validation, geometry, camera video/canvas, QR/PDF generation
and SVG artwork stay application code.

**Reference form:** `AdminProductEditor.svelte`. Every row sits on `formGrid` (two
columns on phones, four from 48rem) so field edges line up; wide fields span
columns. Values stay decimal strings; components do not replace domain validation,
request identities, permissions or database totals. Long forms stay one page, not a
wizard: fields sit under `section` headings in working order, a choice that gates the
rest comes first and the dependent fields grow in below it, and rarely used optional
fields fold into a `Collapsible` that starts open when one has a value.

**Buttons:** `default` is the primary, `outline` secondary, `ghost` quiet, `link`
inline navigation in link blue (never brand red). `href` renders an anchor.
Default height 48px; compact sizes keep 44px targets; labels wrap. The primary is a
square **wireframe**: opaque 10% primary tint, primary hairline, `--primary-ink`
sentence-case label and corner marks (also on `AlertDialog.Action`). `outline` is
square without marks. Labels are never mono or capitalized. `variant="night"` is the primary on the `--night` hero.
One primary per region: submits and page-level create are `default`, row actions
`size="sm"` `outline`, cancel and disclosure `ghost`. Buyer back links are `link`
buttons with a leading arrow icon; admin detail pages rely on the breadcrumb.
Never use disabled opacity as the state cue.

**Fields:** compose `Field.Field`, `Field.Label`, `Field.Description`, `Field.Error`
with `Input`, `Textarea` or `NativeSelect.Root`. Unit affixes use `InputGroup`,
with the unit in the accessible name but not repeated visually. `QuantityStepper`
uses the same group; its owner supplies exact-string arithmetic.

**Choices:** `Switch` for persistent on/off, `Checkbox` for selection or confirming
a condition, `RadioGroup` for exclusive form choices, `ToggleGroup` for compact
filters. Checked states fill with neutral `--foreground`, never `--primary` (red
reads as a problem).

**Locations are picked on the shelf graphic, never from a dropdown.** A product's
drawer, a bin's parent cabinet, a swap target or a count drawer filter uses
`ShelfPlacementPicker` (wall → cabinet through `ShelfZoom`, both levels
`ShelfDiagram`), with a text readout and, when optional, a clear action. The chosen
place gets the public map's yellow outline at both levels. More generally: check
whether an existing graphical component already covers an interaction before adding
a control, and never render the same choice twice.

**Sliders and charts:** catalog `Slider` thumbs are integer indices into recorded
decimal strings, never floats. `Chart` values stay decimal strings, with no motion and
a keyboard-accessible daily-data equivalent.

**Surfaces and feedback:** `Card` for an independent region, `Alert` for important
state, `Badge` for a short state/count/identifier, `Skeleton` and `AspectRatio` to
reserve geometry, `Item` for rows, `Table` for tabular data. Dividing lines use `Separator` (never `border-*`/`divide-*`); control outlines,
state indicators and artwork stay borders. **A failed load** is one pattern
everywhere (and never renders as zero stock): an inline destructive `Alert.Message` followed by an outline Retry
(outside any live region), keeping previous content. A pending change that must be
finished first is an inline `Alert.Message` followed by a `link` resume button.

**Disclosure and dialogs:** `Collapsible` with `DisclosureTrigger` for content that
grows below its trigger, including inline confirmations and row edits (no native
`<details>` or ad-hoc toggles). `Dialog` uses `preventScroll={false}` and a localized
title and close control; it has no default close button. Centered content is bounded
by the dynamic viewport height. Use header/body/footer rows with a named `sheetBody`
scroll region when its content can exceed that height, keeping actions reachable in
landscape. Portaled text wraps within the surface and close controls never shrink.
Product comboboxes fit the popover's available height, retaining the search field
above a shrinking result list. Keep Escape, outside
interaction, return focus and in-flight guards. Destructive or irreversible actions
(archiving, cancelling an order, finishing a count, clearing contacts) confirm with
`AlertDialog`. An acknowledged shelf swap shows a localized `Sonner` toast;
cancelled or uncertain requests do not.

**Category label and illustration:** the category is plain `text-muted-foreground`
text, localized (see [i18n.md §6](i18n.md#6-what-is-not-translated)), omitted beside
a name that already starts with it (`categoryBesideName`). `CategoryGraphic` shows one
decorative transparent WebP per category (source notes:
[assets/components/README.md](../assets/components/README.md)); unknown categories
use a generic IC. Callers reserve its dimensions; no animation, no bordered surface.

**Header and menu:** one DOM with CSS-only presentation (`Collapsible.Content
forceMount`). The row holds the wordmark, the desktop Admin and catalog icon buttons,
the cart icon and a 48 px menu button. The menu floats over the page (a 16rem panel
on desktop, full width at ≤ 40rem) and closes on Escape, outside tap or navigation;
with `html.no-js` it is the header's second row, so links work without JavaScript.
Icon buttons have an accessible name and a matching `Tooltip`. The current link has
`aria-current` and a shape cue (border, or a thick underline in the language
picker), never colour alone. Admin appears only after an active membership check and
never moves the catalog link. The cart's neutral count badge appears only when it has
lines («?» when unreadable) and overlaps the icon so nothing moves. The admin
`Sidebar` is a modal sheet below 48rem and a collapsible rail above; behaviour in
[page-admin-stock.md](page-admin-stock.md#overview-and-statistics).

**Bin label:** a depicted label is an export from the real print renderer
([page-labels.md](page-labels.md)), black on white with its QR quiet zone intact in
both schemes, with alt text naming the code and specifications.

**Focus:** `:focus-visible` is two layers everywhere: a 2 px `--ring` outline (link
blue, 2 px offset) plus a 2 px `--focus-contrast` box-shadow. An element with its own
`box-shadow` state combines both layers. The unlayered global rule in `app.css` is
the only focus style; primitives carry no `focus-visible:ring-*` classes. Where a
`--yellow` outline marks a highlight, `--focus-contrast` gives it a dark edge.

**Motion:** at most 160 ms ease-out for hover/press. The shelf map's wall↔cabinet
zoom (450 ms, user-initiated) is the one spatial transition.
`prefers-reduced-motion: reduce` removes transitions and animations.

**Never clipped.** Strokes and rings spread outward, so ink flush to a boundary is cut:

- Inline SVG: stroked shapes keep ≥ 3 viewBox units of padding to every edge (more
  for wider halos or filters). Fill-only shapes may sit flush.
- CSS: no `overflow: hidden/scroll/auto/clip` on an ancestor of a focusable element,
  except the named §4.2 regions. `:focus-visible` needs 4 px of clearance.

`bun run check:ink` enforces the SVG rule and lists every clipping declaration for
review. Then tab through every control at 360 and 1280 px in both schemes and
confirm each focus ring is whole.

## 6. Brand assets

| Use | File (`static/brand/`) |
|---|---|
| Header wordmark | `wordmark.svg`: lit segments only, up to 11rem wide (9rem on phones). Light mode darkens it with a CSS filter |
| Mark | `mark-square-{180,64}.png`: touch icon, favicon and footer/admin mark |

The designer SVGs in `assets/brand/` are Inkscape sources, not served; see
[assets/brand/README.md](../assets/brand/README.md). If the wordmark image fails,
its `alt` «Ampoteket» renders in the link's own type.

**Link previews:** each page adds its own `og:title` and `og:description` beside its
`<title>`; the locale layout emits the rest. The two `theme-color` tags in
`src/app.html` repeat the surface token per scheme; change them with `app.css`.

### 6.1 Photographs

The served photographs are Hjalmar Karlsen's, supplied for Ampoteket
([assets/photos/README.md](../assets/photos/README.md)). A photograph from elsewhere
needs verified rights for every use and crop; a credit alone is not enough.

- **Every photograph carries a credit** in a `<figcaption>` naming the photographer,
  plus a source link when external. Never a tooltip or footer line. The homepage sets
  it vertically along the right edge with a camera icon for "Foto"/"Photo" (kept as
  screen-reader text).
- **Sized for its slot.** `bun scripts/build-photos.ts` builds WebP derivatives into
  `static/photos/`, selected with `srcset`/`sizes`, in a CSS-sized box. A phone's
  download stays ≤ 100 KB. Only the hero loads eagerly (`fetchpriority="high"`).
- **Text on a photograph needs a guaranteed dark field.** Text sits only over dark
  areas of night shots on `--night`; never a translucent veil or blur. Verify AA
  contrast at 360 and 1280.
- **Two presentations.** A *stage* (hero, bench) is a full-width black band; the photo
  is feathered in with Tailwind edge masks, and `scheme-night` points the ordinary
  tokens at the night palette. A *figure* (the shelf) fills a `rounded-xl` night frame
  close to the photo's aspect ratio. Use stages sparingly.

## 7. Copy rules

- Trust users with familiar controls and visual cues. No legends for an obvious
  selected outline, no checkbox or search tutorials, no text repeating a heading,
  label or visible result. Keep non-obvious constraints, payment/counting
  consequences and error recovery where they matter.
- Say what happens, in this order: *skann → betal → registrer*.
- Payment: «Betal i Vipps, og registrer kjøpet etterpå.» Never «Betal nå», never
  «bekreftet av Vipps», never a green check on payment. Success is neutral:
  «Kjøpet er registrert».
- Stock: numbers are «registrert saldo». Errors read «Ukjent», never «0».
- Network failure after paying: «Prøv registreringen på nytt med samme kasse. Betal
  aldri to ganger.»
- Codes always in mono. A page uses **one** example code throughout (the landing
  page uses `RES-00026`). Prices only in catalog and checkout, always the exact
  database string, with «kr» / “NOK” via `currency()` / `formatMoney`, mono semibold.
- Photo credits are translated («Foto:» / “Photo:”); names are not.
- People: buyers (members and guests alike, no accounts) are «du». **«admin» is an
  internal role name**, used only for the Admin login link, admin screens and docs.
  Buyer copy says «en frivillig» (or «noen i komiteen»), never «spør en admin».
  Nothing user-facing says "staff".
- Names of things: delene («deler»), delekatalogen (`/p`, nav «Delekatalog»),
  handlekurven (`/cart`), kassen (`/checkout`), skuff (drawer), kabinett (cabinet),
  område (area). English uses the same tone: parts, the parts catalog, the cart,
  checkout, drawer, cabinet, area, admin.
- Norwegian is the source language; write it first. Norwegian uses «», English “ ”.

## 8. Accessibility baseline

WCAG 2.2 AA. Landmarks (`header`, `nav`, `main`, `footer`), one `h1`, headings in
order, skip link, visible focus, 4.5:1 text contrast in both schemes, state never by
colour alone and never by opacity, meaningful `alt` or `alt=""` on every image,
visible form labels, correct `<html lang>` (`nb` / `en`) and `hreflang` alternates.
Decorative LED digits are `aria-hidden` with the plain value in visually hidden
text. Reading, following links and switching language work without JavaScript; JS
only enhances (cart badge, direct code navigation, scanner).
