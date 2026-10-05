# Admin orders and receipts

`/admin/orders` records supplier orders already placed elsewhere and stock arriving
without an order; `/admin/orders/[id]` shows lines, derived progress and history.
Implemented in `src/routes/[[locale=locale]]/admin/orders/`,
`src/lib/AdminOrderReceipt.svelte` and `src/lib/admin-orders.ts`, on the staff views
and RPCs in [datamodell.md](datamodell.md).

## Orders

- Orders with outstanding lines come first, newest first within open and completed
  groups. The list shows 20 orders initially; «Vis flere» appends the next 20.
  Each order has a status badge. Completed means no quantity remains outstanding,
  whether received or cancelled. Only open orders offer «Registrer mottak».
- Placement times follow the [time rules](website-guide.md#6-numbers-the-frontend-must-respect).
- Unit cost is per sale unit; freight and other costs go on the order header.
- The product picker includes unpublished products and marks them in the results
  and selected value, since past orders must stay recordable. While a line has no product, a plus button beside the picker opens the
  New product editor in a sheet above the order; saving selects the new product on that
  line and fills an empty purchase link.
  Its search stays visible while the result list scrolls within the available
  popover height, including short landscape viewports. If the keyboard covers the
  trigger, the picker anchors at the visual viewport edge. On extremely short
  screens, dismissing the native keyboard exposes the full result list.
- New order shows **Må bestilles** as toggle chips right above the first line, for
  active products that are sold out or below their minimum, most urgent first. Each
  chip has a stock state icon, its stock and any quantity already on order. Pressing a
  chip adds its line with the saved purchase link (replacing an untouched blank line);
  releasing it removes that line. Nothing starts pressed, and quantity and cost stay
  blank. The chips are absent when nothing needs ordering and in unplanned receipts.
- Chips show the eight most urgent products plus every product with a line; a chip
  used in the form stays until reload, so releasing it never moves the row. With more
  than eight, «Alle N» opens a `Dialog` listing all of them as checkbox rows with code,
  stock and quantity on order. Choices there change the lines at once; Escape or
  «Ferdig» closes only the dialog.
- `?new` opens the New order form.
- Quantities follow the stock step.
- Invalid values show an associated field error and move focus to the first invalid
  field. A generic form failure does not replace quantity, cost or product guidance.
- Recording an order changes no stock.
- Choosing a product on the last line adds an empty line below it, so there is no Add
  line button. Saving ignores lines left completely empty.

## Receipts and progress

An **unplanned receipt** (including donations) needs products, positive quantities and
a source note. A **planned receipt** belongs to one order: checking a line takes its
current outstanding quantity (never the original), and never more. A scan only
highlights the matching line; it never selects a quantity or changes stock.
The confirmation is «Registrer mottaket» for both receipt forms. Planned receipts
show the selection requirement next to the confirmation button.
Each line shows its product's drawer (or location note) so the delivery can be
shelved from the sheet; a failed placement read only omits it.
The full supplier name wraps in the scrolling receipt body; the short title, Close
and confirmation action remain outside it, including in short landscape viewports.

The database derives progress as ordered minus received minus net cancellations,
floored at zero. Cancellation opens below a disclosure, needs a reason, is confirmed
in an `AlertDialog` and changes only the commitment. A mistaken one is reversed
once by a new audited record; its confirmation explains that the reversal cannot
itself be undone. Both confirmations use the destructive action style.
No history is overwritten. Metadata edits are limited to the fields in
[website-guide.md](website-guide.md) §5.5.

## Retry and conflicts

- Before a stock- or commitment-changing RPC, persist its request ID, Auth user and
  exact payload in browser storage. If storage is unavailable, disable these writes.
- An uncertain result keeps the command frozen for an identical retry; a timeout never
  becomes a second receipt. Warn only if the request ends without a confirmed result.
- A successful receipt closes the sheet and refreshes the list.
- An open receipt sheet revalidates on tab return and reconnect, keeping its selection
  and typed quantities. Changed outstanding quantities require review rather than
  silently changing what the operator will receive.
- Conflicts release the command only after a fresh review. Another identity cannot
  continue a pending command.
- Access failures retain drafts and pending commands, gate writes and offer access
  retry inside the active sheet. Credential checks cannot leave the sheet busy after
  a synchronous failure.

Browser checks: `./scripts/test-web.sh --orders`; results in
[VALIDATION.md](../VALIDATION.md).
