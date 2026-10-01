# Admin orders and receipts

`/admin/orders` records supplier orders already placed elsewhere and stock arriving
without an order; `/admin/orders/[id]` shows lines, derived progress and history.
Implemented in `src/routes/[[locale=locale]]/admin/orders/`,
`src/lib/AdminOrderReceipt.svelte` and `src/lib/admin-orders.ts`, on the staff views
and RPCs in [datamodell.md](datamodell.md).

## Orders

- Placement times follow the [time rules](website-guide.md#6-numbers-the-frontend-must-respect).
- Unit cost is per sale unit; freight and other costs go on the order header.
- The product picker includes inactive products, since past purchases must stay
  recordable. A line without a product links to the New product editor in a new tab.
  Its search stays visible while the result list scrolls within the available
  popover height, including short landscape viewports. If the keyboard covers the
  trigger, the picker anchors at the visual viewport edge. On extremely short
  screens, dismissing the native keyboard exposes the full result list.
- `?new=<product ids>` prefills lines with saved purchase links; quantity and cost stay
  blank.
- Quantities follow the stock step.
- Invalid values show an associated field error and move focus to the first invalid
  field. A generic form failure does not replace quantity, cost or product guidance.
- Recording an order changes no stock.
- Add line stays in the scrollable sheet body and Save in its fixed footer, so the two
  are never confused.

## Receipts and progress

An **unplanned receipt** (including donations) needs products, positive quantities and
a source note. A **planned receipt** belongs to one order: checking a line takes its
current outstanding quantity (never the original), and never more. A scan only
highlights the matching line; it never selects a quantity or changes stock.
The full supplier name wraps in the scrolling receipt body; the short title, Close
and confirmation action remain outside it, including in short landscape viewports.

The database derives progress as ordered minus received minus net cancellations,
floored at zero. Cancellation needs a reason, is confirmed in an `AlertDialog` and
changes only the commitment; a mistaken one is reversed once by a new audited record.
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
