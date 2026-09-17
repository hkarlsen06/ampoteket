# `/` — landing page

Implemented in `src/routes/[[locale=locale]]/+page.svelte`; header and footer in the
sibling `+layout.svelte`. Also served at `/en`. Copy lives in `src/lib/i18n/{nb,en}.ts`
under `home` (picker copy under `shelfMap`). Design rules:
[design-system.md](design-system.md); copy rules: [i18n.md](i18n.md).

## 1. Job of the page

`ampoteket.no` is the whole place, not just the shop. The page first **says what
Ampoteket is** — a student-run electronics workshop at Pilestredet 35 with equipment,
courses and people — and then **gets a phone to the parts shelf in one tap**: someone
at the shelf must reach the scanner or `/p` without reading anything. The shelf comes
after the workshop.

Hard constraints:

- **Optional server topology.** The server reads `amp_shelf_map` with a three-second
  deadline; on failure the workshop content still renders and the map falls back to a
  client read. The homepage shows no quantities or prices.
- **Readable and navigable without JavaScript**, including the language picker.
- **First paint on one round trip on bad wifi:** HTML + CSS < 30 KB and one 5 KB
  webfont. The hero photograph is the only eager image (`fetchpriority="high"`); every
  photograph sits in a CSS-sized box so nothing shifts. The 3D viewer loads only when
  the equipment models are within one viewport height.
- **Payment is never described as verified. Scanning never buys.** Static copy never
  contains a payment recipient or Vipps number; checkout is the only source.
- **Facts must be sourced** from the OsloMet story linked on the page (§2.2, §2.3).
  Never invent opening hours, membership rules, prices or equipment; if it is not in
  writing, say where to ask.
- **Photographs are the owner's own** (`assets/photos/`, credited to Hjalmar Karlsen).
  Do not reintroduce the OsloMet article photograph without checking its use rights.

## 2. Structure

Sections below the hero open with their `h2` and a circuit trace under it. No
eyebrows or section numbers.

### 2.1 Header and footer (`+layout.svelte`)

The header holds the wordmark, the cart icon (badge from
`localStorage["ampoteket:cart"]`), the scanner trigger and a menu button. The catalog
link, Admin link and language picker live in the menu panel at every width, so nothing
moves when it opens. Without JavaScript the button is hidden and the panel is the
header's second row (`html.no-js`, set in `src/app.html`). The Admin link appears only
after active staff membership is confirmed; the footer login link is always there. On
phones (≤ 40rem) the scanner is a Scan button in the hero, then a floating button once
that scrolls under the header. The layout emits site-wide link-preview metadata; this
page adds `og:title` and `og:description`.

### 2.2 Hero

A scheme-stable `--night` stage telling one walk: up to the lit storefront window, then
inside. The copy names the workshop, what is in the room and where, and leads to `/p`.
The headline scales with its column (container query) so a wide fallback font cannot
push it into the status strip. The catalog button stays in the first viewport down to
320 × 568. Holding it for 600 ms opens `/admin` instead: a hidden staff shortcut,
not an access control (the admin layout still requires sign-in).

**Walk-in.** With scroll-driven animation support and motion allowed (`scroll-motion:`
in `app.css`), the section is a tall `view-timeline` with a pinned stage: the copy
fades, the storefront grows and dissolves into the room photograph, and Eirik Holm's
quote rises in. CSS only; no scroll listener. At the end the action row turns
`visibility: hidden` so a faded button takes no taps or focus. On phones the scanner
dock fades, so the floating trigger takes over when a mark 27svh below the section top
passes the header. Without support or with reduced motion, the same DOM stacks as two
still figures.

The frame is decorative (`aria-hidden`) except the clock link. The Oslo clock is green
while OsloMet's Pilestredet buildings are open and red when closed, per
[student.oslomet.no/apningstider](https://student.oslomet.no/apningstider) (Mon–Fri
06–22, weekends 08–22; holidays not modelled). These are building hours, not
Ampoteket's staffed hours. Each photograph's credit runs along its right edge.

### 2.3 «Dette er Ampoteket»

Opened 26 February 2026, run by the student associations The Resistance (electronics
engineering) and RoboMEK (robotics), supported by the Department of Mechanical,
Electronic and Chemical Engineering (MEK) at OsloMet, students in charge. The section
links the OsloMet story that sources the quote and facts. The opening date is an LED
cell with `aria-hidden` digits and the readable date in visually hidden text, so
reading never depends on the DSEG7 font.

### 2.4 «Utstyr og aktiviteter»

A full-width night stage with the bench photograph and the heading over it. The whole
photograph is always shown, never cropped. With scroll motion it switches on like a CRT
(`power-on`, `view()` timeline). The figure must not get `overflow: hidden`: that makes
it the image's scroll container and stops the timeline.

Below it, two panels (equipment; courses, project evenings, prototypes and
collaboration), each with a 3D model. WebP posters are the loading state and remain
without JavaScript, without WebGL (the viewer is never mounted), with reduced motion
and if the GLB fails. Viewers have fixed dimensions and localized alternative text. The
models must stay browser-rendered 3D meshes, never image sequences or video. Touch
never tilts them. Sources and limits: [`assets/models/README.md`](../assets/models/README.md).

- **Printer** (Bambu Lab P2S, logo-free). Scrolling through the viewport turns it about
  90° counterclockwise from above (camera azimuth +45° → −45°), clamped; never a full
  spin. Hover turns its front toward the pointer (≤ 30° horizontal, 15° vertical).
  Rebuild: `blender -b --python assets/models/build-p2s.py`.
- **Soldering station.** Document scroll scrubs the paused `Soldering` clip from iron
  in holder to tip on a board pad as the stage centre moves from 110% to 35% of the
  viewport height. Clamp, reverse naturally, never autoplay or loop. After withdrawal
  the iron follows the mouse (≤ 25° / 12° around its tip), blended in so it never cuts
  through the holder. Rebuild: `blender -b --python assets/models/build-soldering-station.py`.

### 2.5 «Delehylla»

The page's one `band` (design system §4.3), marked by full-width hairlines: the
workshop, then the shelf. The
drawer-wall photograph and the three steps (find, pay in Vipps, register) share one
night frame. No retry line; recovery lives in checkout
([checkout-recovery.md](checkout-recovery.md)).

Beside the lookup Card sits a printed example label with the renderer's proportions and
white background in both schemes. `static/labels/home-{nb,en}.svg` are exports from
`src/lib/labels/render.ts` (`prepareLabels`, `proportionalLabelSettings(45)`, one copy,
cut guides) for the real `RES-00026` part; the QR encodes `ampoteket.no/p/RES-00026`.
Regenerate them with the same helpers when the example or print layout changes; static
SVGs keep the PDF and QR machinery off the homepage.

### 2.6 «Slå opp en del»

One Card inside «Delehylla» holds the code form and a «Finn i hylla» button that opens
the shelf picker. No scanner duplicate in the Card. Opening the picker never stretches
the page or moves code entry.

**Code lookup.** A labelled mono input (`pattern="[A-Za-z0-9][A-Za-z0-9-]{0,39}"`,
`autocapitalize="characters"`, placeholder `RES-00026`). Without JS: `GET /p?code=…`.
With JS: trim, uppercase and go to `/p/[code]` in the current language.

**Sheet.** The shared `Dialog` (right side on desktop, full width on phones) with a
localized close control; the named `shelf-picker-body` scrolls natively with
`overscroll-behavior: contain`. Keep `preventScroll={false}`, focus containment, Escape
and focus return. Mount the map on first opening and keep it while hidden, so reopening
preserves the selection and loaded contents. Without JavaScript, hide the sheet and
scanner triggers and keep the map's fallback and catalog links.

**Advancement.** Selecting a cabinet advances the sheet to the zoomed cabinet;
selecting a drawer (or retrying its contents) advances once loading settles, including
empty and error states. Scroll only the sheet body and focus the revealed heading with
`preventScroll`. Background refresh never advances. Closing cancels any pending
advancement, including responses that arrive after reopening.

**Shelf map.** The shared `ShelfMap`/`ShelfDiagram`, with nothing selected at first. A
drawer lists its public components as links to their product pages, without prices or
quantities. Use the complete topology, including unassigned drawers; never derive the
layout from catalog rows. Only a drawer whose topology has `has_products` starts a
catalog read. Empty, unavailable topology and unavailable contents are distinct states
with contextual retries. Reuse the shared map's refresh on focus, visibility and
reconnect, selection preservation and stale-response rejection.

### 2.7 «Hvem kan bruke Ampoteket?»

Students (join The Resistance or RoboMEK to help run it) and volunteers. Access requires
membership; there is no visitor option. One line says the clock follows OsloMet's
building hours, with the source link.

## 3. Visual rules

- LED cells only for the step numbers, the opening date and the clock; never on the
  printed label or the shelf diagram, which would imply displays the cabinets lack.
- The circuit-board motif is the heading traces only. New sections follow the
  «Utstyr og aktiviteter» panel pattern. One example code: `RES-00026`.
- One `h1`, an `h2` per section, `h3` inside. No «staff» in user-facing copy.
- Check both languages at 320 × 568, 360 × 640, 768 and 1280, both schemes, and with
  JavaScript off. The hero headline breaks first.

## 4. Acceptance

`bun scripts/home-printer-proof.ts` and `bun scripts/home-soldering-proof.ts` check the
models against the dev server. Executed checks are in [VALIDATION.md](../VALIDATION.md).
Still open:

- The walk-in on a real iPhone (Safari) and Android phone.
- Lighthouse (mobile and desktop).
- Link preview in a real sharing debugger (checked only in source).
- External phone cameras opening the scheme-less label QR address.
- Opening hours: the footer says they are on the door until we have them in writing.
