# Admin products, placement and counts

Staff screens for products, placement, counts, withdrawals and corrections, under
`src/routes/[[locale=locale]]/admin/`. The product form is
`src/lib/AdminProductEditor.svelte`; counts share `src/lib/CountForm.svelte`.
[Labels](page-labels.md) and [orders](page-admin-orders.md) have their own pages. All
routes need an active personal admin identity and call the audited staff views and
RPCs ([datamodell.md](datamodell.md)) with the operator's own JWT. The database is
authoritative.

## Overview and statistics

The shared sidebar's mobile/desktop render branch is a navigation-only exception to the
one-DOM rule; resizing never replaces the mounted editor or its unsaved input.

`/admin` shows registered purchases and sales value for 30 days, active products
needing attention and open count batches. Needing attention means zero or negative
recorded stock, or below the product's own minimum; never invent a global threshold.
Open stocktakes always precede products needing attention, including when none are
open; background refresh never swaps the sections. The preview shows eight products (sold out, negative before
zero, then lowest share of the minimum) and the five oldest open stocktakes.
«Start en bestilling» opens the New order form at `/admin/orders?new`, which lists
every product needing attention ([orders](page-admin-orders.md#orders)).

`/admin/statistics` graphs 30 days of purchases and ranks up to ten products by sales
value; a saved product's **Statistics** tab shows its own figures (tab changes keep the
editor's unsaved input). Rules, with aggregation in
[`amp_admin_statistics`](api-contract.md#staff-statistics):

- Period, counting and valuation follow the linked contract; the figures are
  registered purchases. Public pages show no sales history.
- Only plot coordinates are JS numbers; quantities and money stay strings.
- Graphs include zero days and a keyboard-accessible data table, with no animation.

## Products

`/admin/products` lists active and inactive products, searching after complete keyset
pagination. Default sort is needs attention (overview order), then other active, then
inactive; alternatives are longest since count, code and name. There is no lowest-stock
sort because unlike units do not compare. Search includes a hyphen-free code alias
(`res00026` finds `RES-00026`), here and in the count picker. **Scan product** opens a
label's editor for any loaded product; unknown labels stay in the dialog. This scan
never changes stock or the basket.
Its camera/status body scrolls in short viewports while Close and retry actions
remain outside the scrolling region.

- The form reads top to bottom in working order: *Category and name*,
  *Specifications*, *Placement*, *Sales and stock*, then *Description and links*,
  folded while all three are empty (opened for an invalid link). A new product starts
  with only the category cards (`CategoryGraphic` + name, one `RadioGroup`); the rest
  grows in below once one is chosen, and the cards stay put. A saved product changes
  category in a compact select. One page, never a wizard: editing jumps straight to
  any field.
- Names are bilingual. Component categories
  (resistors, capacitors, diodes, LEDs, bipolar transistors, MOSFETs) lock the singular
  category label as a name prefix; the full name is stored.
- Typing one name drafts the other (`translateName`, `src/lib/name-translation.ts`)
  until staff edit it. Leaving a name tidies values (`tidyNameMeasurements`:
  `100 uF` → `100 µF`, `4k7` → `4,7 kΩ`) and fills the matching empty specification.
  Typed values are never overwritten.
- Code, stock unit and stock step are immutable after creation. Stock is a recorded
  balance, never an editable field or a zero shown for a failed read. Zero price is
  valid. Deactivation keeps identity and history.
- Minimum in stock (default 0) drives «Lite igjen» on staff views only.
- A product may be published without a drawer, with an optional public location note;
  choosing a drawer clears the note.
- `datasheet_url` is public; `purchase_url` is a staff-only reorder link, separate from
  the history-derived `purchase_order_lines.purchase_url`.
- The editor counts through CountForm in a dialog and prints through **Print**
  ([P-touch tape labels](page-labels.md#p-touch-tape-labels)). Beside the balance it
  shows any quantity still on open supplier orders and links to the product's
  [stock history](#stock-withdrawals-and-corrections), which links back.
- A new product takes its opening stock and a **Print label** choice in the same
  form. The quantity travels in the creation command and is posted once that command is
  acknowledged, as a single count against balance 0 at revision 0 (empty means never
  counted, zero is a count). A stored count that fails is reopened by the count dialog;
  one that could not be stored keeps the editor open with an error. **Print label**
  (checked once this browser holds the printer) picks the printer during the Save
  click and prints once the editor opens on the product's route; a cancelled picker
  just leaves **Print**.
- Drawers are picked on the shelf graphic (`ShelfPlacementPicker`), never a coordinate
  dropdown (design-system §5). Changing an existing placement is confirmed in an
  `AlertDialog`, changes only the draft, and is saved by **Save product**.

**Categories.** Choosing a standard category for a new product picks the code prefix;
five random hex digits complete it (`RES-A3F09`). The 14 standard categories work with
no category rows in the database: `RES` Resistors, `CAP` Capacitors, `DIO` Diodes, `LED`
LEDs, `BJT` Bipolar transistors, `MOS` MOSFETs, `MCU` Controllers, `SEN` Sensors, `MOT`
Motors, `DRV` Motor drivers, `CON` Connectors, `BRD` Prototyping, `CAB` Cable, `MIS`
Miscellaneous.

A category change never changes a saved code, QR target or history. Custom, legacy
("Transistors") and uncategorized products keep their category until an operator
picks a standard one; never infer it from the code prefix. On save, reuse the row with
the standard name or create it through `amp_categories` with its predefined stable ID.
To extend the list, update `productTypes` in `src/lib/admin-products.ts` and both
dictionaries. Canonical names and IDs are data identities, not copy.

**Save and retry.** Persist the product command (actor, UUID, code, exact payload,
category requirement) before writing. A lost response is retried with the same
identities, never a replacement product or category. Only a definite code-uniqueness
rejection permits a new code candidate. Category and product are separate writes, so a
category may survive a failed product save. Edits check the displayed metadata
revision; a stale draft needs review, never a blind overwrite. After creation the
editor replaces the `/new` history entry with the product's route.

### Predefined specifications

Standard categories suggest fields; Miscellaneous, custom and uncategorized products
show the full set. Staff can add a custom type (label, scalar type, optional unit).
Existing values stay visible when the category changes.
The new-type dialog keeps its title, Close and Save visible while its form body
scrolls in short viewports.

- Fields are edited in place and written by Save product. All are optional; clearing
  removes the value, and unknown values stay missing, never zero or false. An invalid
  number blocks the whole save.
- Each changed specification is its own persisted, acknowledged command after the
  metadata. Partial failure keeps the command for retry or review. A value changed by
  someone else stops the save and shows the current value; saving again replaces it
  deliberately. An uncertain response locks the field until the next Save.
- Missing definitions are created through `amp_attribute_definitions` with their stable
  UUID, then values go through `amp_product_attributes`. A conflicting definition is
  reported, never reinterpreted.

`src/lib/product-specifications.ts` defines the standard fields (code, type, canonical
unit) and the category mapping. SI fields accept prefixes and units (`27p`, `4k7`,
`0R47`, `1000 ohm`; `m` ≠ `M`) and store the canonical number (`parseMeasurement` in
`format.ts`). Add a field by extending the mapping and both dictionaries; codes, UUIDs,
types and units are data identities.

## Placement

`/admin/shelf` maintains cabinets, drawers and product assignments. Coordinates, not
invented labels, identify places; identities survive moves. Row 1 is at the bottom,
column A on the left, spans anchor bottom-left. Cells are at least 24px; dense layouts
pan in a named keyboard-accessible viewport without horizontal page overflow.

The migration seeds 12 Raaco 150-system cabinets (306 × 552 mm), six columns by two
rows:

| Wall positions | Drawer rows × columns | Drawers |
|---|---|---|
| A1, B1, C1, D1, B2, D2, E2, F2 | 12 × 4 | 48 |
| A2, E1, F1 | 8 × 3 | 24 |
| C2 | 10 × 4 | 36 |

C2 has two wide drawers (A1–D1, C2–D2) from the merged cells in `Bok.xlsx`: 496 cells,
492 drawers, no products or stock inferred.

**Layout editor.** Selecting a cabinet opens its editor in the page with Save and
Discard; unsaved changes block switching cabinets. Border grips (or arrow keys and
add/remove buttons) add rows and columns, up to 4,096 cells; a width grip resizes the
selected drawer. Save commits atomically. Rules, rechecked by the database:

- Widening keeps the drawer's ID and products and may consume only whole neighbours
  with no assigned products (inactive assignments count).
- Shrinking or splitting an assigned drawer is blocked; splitting keeps the bottom-left
  identity. Grid resizing fills uncovered cells and never removes assigned drawers.
- Loading the map and ordinary moves never generate drawers.

**Moves and swaps.** A mouse can drag the drawer face; touch swipes on faces pan the
diagram. Drag its move grip to move with touch, or use the grip by tap or keyboard. A drop on
another drawer is a confirmed swap; on a vacant cell a confirmed guarded move. Unsaved
layout edits must be saved or discarded first. Only an acknowledged swap shows the
success toast. Moves keep a drawer's products and size.

**Assigned state.** Assignment, not stock, marks a drawer as occupied: zero stock and
inactive products count. The public topology exposes only this boolean. Failed reads
never imply emptiness.

**Retry.** Layout commands store the original snapshot, desired layout, generated IDs,
request ID and user, and survive reload for an identical retry. A stale layout needs an
explicit review, never a silent rebase. Moves carry the original placement as a guard;
swaps carry both positions and one request ID, so a retry cannot swap back. Stale
positions require checking the physical shelf first.

**Archive.** Only drawers with no assigned products (including inactive) can be
archived. The cabinet action archives its unassigned drawers and the cabinet in one
confirmed transaction, or nothing. Archive keeps audit history; the archived list shows
the position recorded at archive time.

## Counts

`/admin/counts` starts named batches owned by the current admin. The owner records each
observation immediately; finishing posts no stock again and is confirmed. Another admin
may close an abandoned batch only if its owner is inactive or has no Auth identity,
with a required reason.

- A batch can limit the product choice to one drawer picked on the shelf graphic;
  the drawer's products are then listed for one-tap choice, marked **Counted** once
  counted in this batch. Search and Scan product remain for unplaced products.
- Pause taking and shelving at the drawer before observing. Keep the revision from the
  displayed balance with the observation.
- Zero is a valid count; a matching count still records a proof of check. Ask for a
  note when it differs. Never total unlike units.
- If stock changed, keep the rejected observation and require a fresh physical recount;
  never swap in a new revision and resubmit. A revision cannot detect unregistered
  handling.
- Count detail reads only its batch; finished batches read only referenced products.

## Stock withdrawals and corrections

`/admin/stock` selects any product (combobox or [scanner](scanner.md)) and shows its
full history. A failed read is unavailable, never an empty ledger.

- A withdrawal records a positive quantity and reason; the database posts it negative.
  An adjustment records a signed non-zero quantity and reason.
- Invalid quantities identify the field and its permitted step, retain the draft,
  and focus the first invalid field. Recounts accept zero; changes do not.
- A correction picks an earlier movement from history, shows linked corrections and any
  affected order line, and carries the history revision. A changed revision needs a
  fresh review.
- If a count followed the movement, the correction needs a fresh physical count and a
  pause acknowledgement, and `amp_correct_movement_and_count` links both in one
  transaction.

## Shared request rules

- **Freshness** follows design-system §4.2: re-read on page open, tab return and after
  acknowledged writes, and once more if a return happened mid-request. Failed reads
  keep the previous content mounted, mark it unavailable and offer contextual retry.
  Actions requiring fresh values wait for a successful read.
- **Conflicts.** After a stale or occupied rejection the map re-reads itself and the
  admin confirms again. Specification conflicts show the current value and need an
  explicit choice; neither replaces the draft.
- **Uncertain writes.** Keep the Auth identity, request ID and frozen payload in browser
  storage across reload. Reauthentication never changes a command's actor. A timeout
  permits only retry of the same command; a confirmed rejection permits editing. Staff
  requests time out after 15 seconds; an abort is not proof of rollback.
- **Access.** A failed membership read makes the editor inert but keeps its state until
  access is rechecked; revocation, sign-out or another identity clears it. Portaled
  editors enforce the same boundary and offer access retry within the active dialog,
  so a pending command never hides its own recovery controls.

Browser checks: `./scripts/test-web.sh --admin`, `--shelf` and `--statistics`. Executed
results and open physical checks are in [VALIDATION.md](../VALIDATION.md).
