# Overlap and boundary tests

The races that must stay correct, and what proves each one. Rules are in
[datamodell.md](datamodell.md) §8; executed results are in
[VALIDATION.md](../VALIDATION.md).

## Why there are no locks

Every command is one Convex mutation, a serializable transaction. When two
transactions conflict, Convex retries the later one, which then sees the
winner's writes (optimistic concurrency control). The row locks, lock orders,
`READ COMMITTED` checks and table lock of the PostgreSQL design are gone, and
nothing can deadlock. The rules they protected still hold because each command
reads what it checks in the same transaction that writes:

- the stock revision a count or correction was based on (`STALE_STOCK_COUNT`,
  `STALE_STOCK_CORRECTION`);
- the before-image of the row or layout an edit was based on (`STALE_PRODUCT`,
  `STALE_SHELF_LAYOUT`, `STALE_BIN_POSITION`, `STALE_CABINET_POSITION`,
  `STALE_HELP_CONTACT`, `STALE_HELP_ORDER`, `'stale'`);
- the stored request in `command_requests`, so a duplicate request returns the
  first result (`convex/lib/commands.ts`);
- the checkout's existing sale, so a checkout is registered at most once;
- the caller's own membership, so a deactivated member cannot finish a command.

## How cases are tested

`tests/convex/concurrency.test.ts` fires commands at the same time against a real
local backend, through separate native clients, and `./scripts/test-convex.sh`
runs it with the rest of `tests/convex/`. To add a case, start the overlapping
calls together (`Promise.all` or `Promise.allSettled`), then assert the outcome,
the ledger and `migration:verifyStockLevels` (which must return `[]`). A
sequential call proves that a guard exists, not that it holds under overlap.

Each section below names its proof: **parallel** (concurrency test),
**sequential** (the guard is tested one call at a time in another file) or **by
construction** (the check and the write share one transaction, with no parallel
test yet).

## 1. Two confirmations of the same checkout

Race: `checkout.confirm` for one checkout, several at once.
Expected: one sale, one event, one set of movements; every call returns the same registration.
Proof: parallel, "duplicate confirmations register one sale" (five confirms, one `confirmed_at`, stock −2). Sequential repeat: `checkout.test.ts`.

## 2. Multi-product checkouts in opposite cart order

Race: confirm checkout A (X, Y) and B (Y, X) together; edit prices while checkouts are prepared.
Expected: both post once and both balances drop by both purchases (negative allowed). Saved lines carry the prices read in the prepare transaction.
Proof: parallel for one product, "many sales of one product keep the ledger exact" (twelve checkouts, twelve movements, stock −12). Opposite order: by construction; without locks there is nothing to deadlock. Frozen prices after a price change: sequential, `checkout.test.ts`.

## 3. Count racing a sale

Race: a sale of X and a count of X submitted with the revision read before the sale.
Expected: if the sale commits first, the count fails with `STALE_STOCK_COUNT` and leaves nothing behind; otherwise the sale subtracts from the counted balance. The UI asks for a fresh count, never resubmits the old one with a new revision.
Proof: parallel for two counts on one revision, "two counts against the same revision: exactly one posts". Stale count after a posted count: sequential, `stock.test.ts`. Count against a sale: by construction.

## 4. Duplicate receipt requests

Race: the same request ID and payload (receive 60 of 100 outstanding) twice at once.
Expected: one event, one +60 movement, 40 outstanding; the duplicate returns the first event ID. The same ID with a different payload fails with `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
Proof: parallel through the shared mechanism, "concurrent duplicates of one request ID get the same result and act once" (five `stock.adjust` calls, one event). Different payload: sequential, `stock.test.ts`. Receipts specifically: by construction.

## 5. Receipt racing cancellation

Race: receive 60 and cancel 60 of 100 outstanding; a linked receipt correction against a cancellation.
Expected: one succeeds and the other fails on the remaining 40. A receipt correction updates the received amount the cancellation checks.
Proof: sequential, `orders.test.ts` (receipt over outstanding refused, cancellation, one reversal, correction kept within the ordered quantity). Overlap: by construction.

## 6. Finishing a batch while posting a count

Race: the owner's `stock.finishCountBatch` against a count in the same batch; duplicate `stock.recordSingleCount` calls with one request ID.
Expected: a count that commits after the finish fails with `COUNT_BATCH_FINISHED`. Finishing never reposts. Other staff cannot post to or close the batch. Duplicate single counts create one batch and one observation.
Proof: sequential, `stock.test.ts` (late count refused, other member refused, owner still active). Overlap and duplicates: by construction.

## 7. Real HTTP and Convex Auth boundary

Automated against a disposable backend:

- `tests/convex/` (native client over HTTP): a checkout call with a wrong Worker
  key fails with `CHECKOUT_SERVER_REQUIRED`; a read with a wrong checkout secret
  fails with `CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED`; deactivated staff get `STAFF_REQUIRED` at
  once and `members.me` shows no membership; a wrong password and an unknown
  address both give `INVALID_CREDENTIALS`; invitation and reset links are
  single-use; the public shelf map and volunteer directory need no session and show
  only published contacts; the imported bcrypt password still signs in.
- `./scripts/test-web.sh` (the boundary proof, `scripts/web-proof/run.ts`): real
  password sign-in in Firefox with sign-up impossible, non-staff denial, token
  refresh across a reload, catalog reads in the browser and through a disposable
  Worker, complete traversal, an exact browser-to-backend price round trip, the
  `__Host-amp_checkout` cookie (Secure, HttpOnly, same value on renewal, survives
  sign-out), fail-closed credential checks and immediate membership revocation. It
  is a test fixture, not operational checkout acceptance. The other proofs
  (`--checkout`, `--admin` and the rest) are being ported to Convex.

Not automated: the production deployment's Convex Auth configuration
(`JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`), real email delivery, the built Worker with
production bindings and a phone. Before launch, check these on the real deployment
with real sign-ins. Checks on production must be non-destructive; never create
fixture purchases in real stock. Every check must also fail outside the UI (a
direct call with the native client), and the remaining launch acceptance rows are
in [website-guide.md](website-guide.md#9-acceptance-criteria-must-all-hold-in-production).

- A signed-out caller can use the five `catalog.*` queries and the sign-in and
  password-link functions, and nothing else.
- A signed-in non-staff user sees no staff data and cannot change stock.
- Active staff can call staff functions and manage other staff through the audited
  membership functions. Ledger and audit rows are written only by the backend's
  own helpers, never supplied by a caller.
- The Worker key opens only the three checkout functions and carries no staff identity.
- A wrong checkout secret or Worker key fails for reads and confirmations.
- Deactivating a membership, or deleting the Auth account, removes access on the
  next call. A recreated account needs deliberate relinking, not name matching.
- Internal functions are unreachable without the deployment admin key, and
  production does not set `ALLOW_TEST_FIXTURES`.
- The Worker maps errors correctly: stale count is a conflict, a retry never
  duplicates, bad quantity is a validation error, unauthorised is an access error.
- Rehearse app switching, lost connectivity after payment, staff recovery with a
  reason, a zero-total checkout, and the nightly contact retention.

## 8. Bin/cabinet swaps and abandoned count batches

Races: duplicate simultaneous bin swaps; opposing swaps from stale forms; two bin moves into one free cell; duplicate abandoned-batch closure; owner reactivation against abandoned closure.
Expected: one exchange; the stale swap fails with `STALE_BIN_POSITION`; the second move into the cell fails with `BIN_POSITION_OCCUPIED`; one closure and one audit entry; a closure after the owner was reactivated fails with `COUNT_BATCH_OWNER_STILL_ACTIVE`.
Proof: sequential, `shelf-and-help.test.ts` (cabinet move into an occupied position refused, stale `shelf.updateCabinet` answers `'stale'`, cabinet swap) and `stock.test.ts` (closure refused while the owner is active). The rest: by construction.

## 9. Independent stale correction forms

Race: two forms read the same revision after a receipt of 60 and each submit a −10 linked correction with different request IDs.
Expected: one commits; the other fails with `STALE_STOCK_CORRECTION`. Received is 50, not 40.
Proof: by construction. A linked correction within range and out of range: sequential, `orders.test.ts`.

## 10. Staff recovery racing the original browser

Race: `checkout.recover` against the browser's confirmation of the same checkout.
Expected: one sale, one event, one withdrawal. If staff win, the recovery actor and reason are kept and the browser's confirm returns `registration_method: "staff_recovery"` without reposting. Lost-credential recovery never creates a replacement checkout or an adjustment.
Proof: sequential, `checkout.test.ts` (recovery, then confirm, one withdrawal). Overlap: by construction; both paths share one registration function, whose duplicate case is proven in §1.

## 11. Corrections with recounts, and storage retirement

Races:

- After a receipt of 60 and a count of 10, a plain correction fails with `CORRECTION_REQUIRES_RECOUNT`. `stock.correctAndCount` (−50, count 10) races a sale of one: if it wins, stock is 9 and received 10; if the sale wins, it fails with `STALE_STOCK_COUNT` and order history is untouched.
- Assigning a product to an empty bin against archiving that bin: the loser fails with `BIN_STILL_HAS_PRODUCTS` or `PRODUCT_BIN_UNAVAILABLE`.
- `shelf.archiveCabinet` with an old snapshot against a drawer change: fails with `STALE_SHELF_LAYOUT`. Duplicate retries give one result and one audit update per row.

Expected: no product ends up in retired storage, and no writer sees half of a correction/recount pair. `shelf.archivedBinLocations` shows each drawer's position at its archive event even if the cabinet later moves.
Proof: sequential, `stock.test.ts` (recount required, correction and count in one command) and `shelf-and-help.test.ts` (archived drawer location). Overlap: by construction.

## 12. Placement writes against grid changes

A drawer move racing a layout save that shrinks or rearranges the cabinet: whichever commits second rechecks placement against the committed grid and fails, so no drawer is left outside its grid. `shelf.updateCabinet` cannot change a grid's size; only `shelf.saveLayout` can, guarded by its snapshot. There is no isolation level to get wrong.
Proof: by construction.

## 13. Concurrent volunteer directory edits

Race: two staff forms read one contact at revision 1; A publishes, B edits the name with the same revision.
Expected: B fails with `STALE_HELP_CONTACT`; A's publication and revision 2 stand. The UI keeps B's draft and asks for review, never retrying with a new revision.

Order moves carry the complete previous and desired ID lists. Of two moves from the same list, the second fails with `STALE_HELP_ORDER` if the first changed the order. Simultaneous duplicate moves both succeed, with one set of audit changes. Retrying a successful move after its response was lost also makes no additional changes.
Proof: sequential, `shelf-and-help.test.ts` (stale edit, stale order, repeated move). Overlap: by construction.

## 14. Saving complete drawer layouts

Races against `shelf.saveLayout`, each expecting the later side to fail cleanly:

- Same request ID twice: one cabinet with its drawers, same result.
- Two edits of one snapshot: the second fails with `STALE_SHELF_LAYOUT`.
- A drawer move commits first: the layout fails with `STALE_SHELF_LAYOUT` and never moves a drawer back. In the other order, the move fails with `BIN_POSITION_OCCUPIED` or answers `'stale'`.
- A product assignment against removing or absorbing its drawer: the layout fails with `LAYOUT_HAS_PRODUCTS`, or the assignment fails with `PRODUCT_BIN_UNAVAILABLE`. An expanded drawer keeps its products either way.

Proof: sequential, `shelf-and-help.test.ts` (an occupied drawer cannot be removed, a saved layout makes the old snapshot stale). Overlap: by construction.

## 15. Staff access changes

- Two active members deactivate each other: exactly one succeeds, and the other fails with `STAFF_REQUIRED`. The winner stays active.
- Deactivation wins over the target member granting access: the grant fails with `STAFF_REQUIRED` and creates no member.
- Duplicate invitation grants with one request ID: both return the same staff ID; exactly one membership and audit insert exist.

Proof: parallel for mutual deactivation, "two members cannot deactivate each other at the same time". Sequential, `accounts.test.ts`: self-deactivation refused, a stale resend cannot revive a revoked member, a failed email keeps the membership and the same request sends again. Grant against deactivation and duplicate grants: by construction. Real email delivery and the browser invitation flow need the checks in §7.

## Open

No parallel test yet covers a count against a sale (§3), receipts against
cancellations (§5), batch finish against a count (§6), swaps and abandoned closures
(§8), independent correction forms (§9), recovery against confirmation (§10),
correction/recount against a sale (§11), placement against layout saves (§12, §14),
directory edits (§13) or grant against deactivation (§15). They hold by
construction; add a case to `tests/convex/concurrency.test.ts` when one of them
changes.
