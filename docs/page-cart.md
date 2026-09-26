# Cart

`/cart` and `/en/cart`, implemented in `src/routes/[[locale=locale]]/cart/+page.svelte`
and `src/lib/CartLine.svelte`; storage and locking in `src/lib/cart.ts`. The checkout
protocol is owned by [checkout-recovery.md](checkout-recovery.md); the next page is
[page-checkout.md](page-checkout.md).

## Lines and actions

One column at 360 px: heading, lines, optional contact field, proceed/resume, result or
help. Scanning uses the [global scanner](scanner.md). Each line shows name, code, unit,
location, recorded stock, quantity and remove. Stock is advisory: it is not reserved,
and a low or negative balance never blocks recording items actually taken.

- Quantities are exact strings in sale steps. Valid edits save automatically. Keep the
  typed text; an invalid or empty draft stays visible without changing the saved
  quantity. Errors name the sale step, including when fresh product facts invalidate
  a previously saved quantity.
- Writes per line are serialized and coalesced under the cart lock, each with an
  expected-quantity check; a conflict shows the saved quantity for review.
- Remove waits for an in-flight save; queued edits never restore a removed line. Empty
  input is never dropped silently. Keyboard removal moves focus to a remaining line
  or the empty-cart browse action without scrolling the document.
- Re-adding a product merges into its line; never send duplicate product IDs.
- The total is indicative; the database's prepared total is what is payable.
- The contact field (phone or email) is optional, unverified, and neither an account
  nor a recovery credential. It stays in tab memory until the payload is frozen.

## Loading and validation

The server renders only the shell. The browser reads `ampoteket:cart` and the attempt
metadata before enabling changes.

- Saved name/code hints are display-only; resolve them by direct lookup and verify the
  product ID. Refresh product facts on entering the cart, tab return and reconnect,
  preserving quantity drafts, contact input and focus. Keep loaded lines mounted
  while checking; unavailable facts block proceeding and offer contextual retry.
- Validate saved data: string quantities, one line per product, at most 200 lines.
  Invalid data is a visible recovery state, never an empty cart.
- A failed read stays unavailable. A product no longer returned must be reviewed or
  removed; never substitute a similar one.
- Proceed is unavailable while a line has an invalid or unsaved draft or unavailable
  product facts. The Worker and database repeat all validation.

## Cart and attempt states

| State | Visible behavior / allowed action |
|---|---|
| Initializing | Stable shell, loading announcement, no premature empty message |
| Empty | Browse and scan; contact and proceed hidden |
| Editable | Edit, add, remove, proceed once valid |
| Invalid/unavailable | Keep lines and inputs with retry; never invent zero stock |
| Preparing, outcome unknown | Retry the same request from the initiating tab; no edits |
| Prepare rejected by a product/quantity rule | Keep the original request and payload; explain the line; never silently edit or reuse it |
| Other tab owns preparing payload | Wait for or adopt its checkout, or help; never rebuild the payload |
| Prepared | Resume the saved checkout; never prepare again |
| Confirming/outcome unknown | Resume the original registration; never abandon or replace it |
| Registered | Identity-checked cleanup, then an explicit new purchase |
| Storage/credential unavailable | Explain recovery and show the reference; no memory-only fallback |

## Proceed, set aside, clean up

- **Proceed.** Take the shared Web Lock, re-read cart and attempt pointer, freeze that
  payload once, read it back and atomically claim the single attempt. No network request
  runs while a lock or transaction is held. Only the tab holding the payload may retry.
  Prepare success does not clear the cart.
- **Set aside.** An acknowledged checkout with no confirmation attempt can be set aside
  only after the buyer states nothing was paid or collected, confirmed inline. It frees
  local editing; the saved checkout stays valid. After a confirmation attempt, finish
  the original retry instead.
- **Cleanup.** Under the lock, verify the request ID and original cart snapshot, clear
  the cart first and the pointer last, so a stale response never clears a newer basket.
  On entering the cart, a known checkout read as registered (also by staff) triggers the
  same cleanup; an unavailable read keeps the cart locked with its reference. Storage
  recovery must never turn a purchased basket into an editable one.

## Acceptance

`./scripts/test-web.sh --shop` and `--checkout`; executed results in
[VALIDATION.md](../VALIDATION.md).
