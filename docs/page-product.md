# `/p/[code]`: product

Implemented in `src/routes/[[locale=locale]]/(sales)/p/[code]/+page.{server.ts,svelte}`, with
the purchase form in `src/lib/ProductPurchase.svelte`. Also at `/en/p/[code]`; printed
labels target the unprefixed route. Basket locking follows
[checkout-recovery.md](checkout-recovery.md).

## 1. Job and layout

Identify the exact part, find its drawer and deliberately add a quantity to the basket.
A code identifies one interchangeable type; several types can share a drawer, and the
drawer's position is separate from that identity.

At 360 px: identity line (catalog link, name, code, category, recorded balance); unit
price; quantity form (stepper, Add, reserved result region showing any cart quantity);
description; shelf map opened on the product's drawer, with its address in the header;
specifications and datasheet link. Unknown values stay absent. Zero and negative
balances explain that physically found parts can still be added.

Below 48rem, description and map are `Collapsible`s that start closed; the map's
compact placement address remains visible beside its heading. From 48rem and
without JavaScript both are open. The content is force-mounted and CSS switches the
presentation. From 48rem the map forms the right column. Actions stay in document flow:
no fixed purchase bar or nested panel.

## 2. Route and public data

- Validate the code grammar and uppercase it; reject invalid codes without a query.
- Fetch one product with `amp_catalog(p_code)` via `requestApiJson`, never by catalog
  traversal. If missing, apply the compact-code fallback
  ([catalog rules](page-catalog.md#3-url-and-matching-rules)) and redirect.
- A valid empty response means no active product at that code: show a localized
  not-found page. The public API has no inactive-product detail.
- HTTP errors, malformed responses and multiple or mismatched rows are unavailable with
  retry, never not-found. Never use a saved cart hint instead of fresh data. After a
  failed refresh, keep the old data readable, marked unavailable, and disable Add.
- The page renders server-side and reads without JavaScript; cart controls say they
  need JavaScript and storage. The only refresh controls are contextual retries.
- Re-read product facts on tab return and reconnect, keeping quantity drafts and
  focus. A failed read keeps the previous product visible with an unavailable state
  and contextual retry; Add waits for a successful read.
- Escape saved text. Link a datasheet only if it is an absolute HTTP(S) URL without
  credentials.
- Canonical, alternate and social URLs are the localized path without query
  parameters, and never contain cart or checkout data.
- Values in names and specifications use `formatMeasurementText()`/`formatMeasurement()`
  (`src/lib/format.ts`): `1000 ohm` → `1 kΩ`, `uF` → `µF`, shifting decimal strings
  exactly. Unknown units and model identifiers stay unchanged; stored data is never
  rewritten.

## 3. Quantity and basket

- Start at `sale_step`. Accept a locale decimal separator, normalize to an exact
  dot-decimal string, and reject ambiguous grouping.
- Require a positive multiple of `sale_step`, at most six decimals and at most
  `999999999999`. Never round, snap or use JavaScript floats.
- Add merges by `product_id` and checks the combined quantity.
- Never require `quantity <= recorded balance`: stock is not reserved, negative
  balances are allowed, and buyers may hold parts missing from the record. The page
  computes no payment total.
- Before enabling Add, confirm storage works and no checkout attempt is active. Under
  the shared cart Web Lock, re-read the cart and attempt pointer, validate, persist,
  read back, then announce success once. A storage failure never claims a save.
- An active attempt locks basket changes on every tab and shows its resume link or
  recovery state. Only the cart's set-aside flow can release it.
- Add stays on the page and updates the header count; it never creates a checkout.

## 4. Location and map

Catalog coordinates show a location before the map loads. A product without a drawer
shows one «Plassering» chip with its staff note, or «Spør en frivillig»; its map
highlights nothing and never reports it as moved.

On mount, fetch `amp_shelf_map()` into reserved space so purchase controls never
shift. Revalidate on focus, visibility and reconnect (no refresh button or polling),
keeping the map, selection, contents and focus. A failed read keeps the old map marked
unavailable, with a retry. Cancel reads and listeners when leaving.

- Match `cabinet_code`/`bin_code` to the topology. Highlight with outline, label and a
  non-colour cue, plus a plain-text address. A1 is bottom-left
  ([website-guide.md](website-guide.md) §7).
- Empty cells come from topology, never from a missing product.
- If catalog and topology disagree, use the topology for both map and address. If the
  bin cannot be matched, show location unavailable and offer a product reload; never
  guess a cell or call it empty. A map failure never blocks a valid product.
- Never read the whole catalog: load the product's drawer, and other assigned drawers
  when selected. Unassigned drawers are empty from topology; failed reads never mean
  empty. Inactive-only drawers can be flagged assigned with no public contents.
- Cells share one Tab stop; arrows move spatially, Home/End reach the ends,
  Enter/Space selects. Cells are at least 24 CSS px; dense grids pan in the named shelf
  viewport (design system §4.2).

## 5. Admin shortcuts (not built)

Signed-in admins are meant to get shortcuts to edit, adjust, count and move, working on
admin screens with their own JWT. Public layout and data stay the same; no service key,
staff record, cost or history enters the public load. Membership, not client
visibility, authorizes.

## 6. Acceptance

`./scripts/test-web.sh --shop`; executed results in [VALIDATION.md](../VALIDATION.md).
