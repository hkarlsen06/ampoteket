# Admin orders and receipts

`/admin/orders` records supplier orders already placed elsewhere and stock arriving
without an order; `/admin/orders/[id]` shows lines, derived progress and history.
Implemented in `src/routes/[[locale=locale]]/admin/orders/`,
`src/lib/AdminOrderReceipt.svelte` and `src/lib/admin-orders.ts`, on the staff views
and RPCs in [datamodell.md](datamodell.md).

## Orders

- Placement times show in `Europe/Oslo`. Entered times reject nonexistent
  daylight-saving times and make the admin choose the occurrence of an ambiguous one.
- Unit cost is per sale unit; freight and other costs go on the order header.
- The product picker includes inactive products, since past purchases must stay
  recordable. A line without a product links to the New product editor in a new tab.
- `?new=<product ids>` prefills lines with saved purchase links; quantity and cost stay
  blank.
- Quantities follow the stock step; quantities and costs stay strings.
- Recording an order changes no stock.
- Add line stays in the scrollable sheet body and Save in its fixed footer, so the two
  are never confused.

## Receipts and progress

An **unplanned receipt** (including donations) needs products, positive quantities and
a source note. A **planned receipt** belongs to one order: checking a line takes its
current outstanding quantity (never the original), and never more. A scan only
highlights the matching line; it never selects a quantity or changes stock.

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
- Conflicts release the command only after a fresh review. Another identity cannot
  continue a pending command.

Browser checks: `./scripts/test-web.sh --orders`; results in
[VALIDATION.md](../VALIDATION.md).
