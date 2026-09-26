# Required two-connection tests

Cases 1–6 and 8–15 are automated in `supabase/tests/concurrency.py`, run by `./scripts/test-database.sh`. Each overlapping case holds the first transaction open until the second is seen waiting on a lock, and runs both orders where listed. Case 7 is partly automated by `./scripts/test-api.sh` and partly a manual launch check. Results are in [VALIDATION.md](../VALIDATION.md).

When adding a case, use two real connections (or two concurrent HTTP requests); sequential calls on one connection prove nothing about locks. Use `READ COMMITTED` and short `lock_timeout`/`statement_timeout` so a regression fails instead of hanging. Lock orders are in [datamodell.md](datamodell.md) §8.

## 1. Two confirmations of the same checkout

Race: `amp_confirm_checkout` for one 3-piece checkout on two connections.
Expected: the second waits, then returns the same result. One sale, one event, one -3 movement. A retry after a timeout returns the same result.

## 2. Multi-product checkouts in opposite cart order

Race: confirm checkout A (X, Y) and B (Y, X) together; separately, edit prices while checkouts are being prepared.
Expected: no deadlock (products lock in UUID order); both post once and both balances drop by both purchases (negative allowed). Saved lines carry the prices read under the locks.

## 3. Count racing a sale

Race: a sale of X holds its transaction; a count of X is submitted with the revision read earlier.
Expected: the count waits, then fails with `STALE_STOCK_COUNT`, leaving nothing behind; the sale stands. In the other order, the sale subtracts from the counted balance. The UI must ask for a fresh count, never resubmit the old one with a new revision.

## 4. Duplicate receipt requests

Race: the same `p_request_id` and payload (receive 60 of 100 outstanding) on two connections.
Expected: one event, one +60 movement, 40 outstanding; the second returns the first event ID. Same key with a different payload fails with `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.

## 5. Receipt racing cancellation

Race: receive 60 and cancel 60 of 100 outstanding; also a linked receipt correction against a cancellation.
Expected: the order lock serializes them; one succeeds and the other fails on the remaining 40. A receipt correction updates the received amount the cancellation checks.

## 6. Finishing a batch while posting a count

Race: the owner's `amp_finish_count_batch` against a count in the same batch; duplicate `amp_record_single_count` calls with one request ID.
Expected: whichever gets the batch lock first wins; a late count fails with `COUNT_BATCH_FINISHED`. Closing never reposts. Other staff cannot post to or close the batch. Duplicate single counts create one batch and one observation.

## 7. Real HTTP and Supabase Auth boundary

Automated by `./scripts/test-api.sh` (isolated PostgreSQL and PostgREST, signed synthetic JWTs): exact decimal and bigint transport, stale-edit rejection, complete pagination under a small row cap, role access for anon, staff, non-staff, disabled staff and service role, bad or expired signatures, hidden `app` schema, invalid checkout secrets and duplicate guest confirmation.

Not automated: Supabase Auth signup, login, refresh and account deletion, the managed gateway, the Worker and a browser. Before launch, check these on a disposable full stack with real Auth sessions, through PostgREST rather than `SET ROLE`. Checks on production must be non-destructive; never create fixture purchases in real stock.

- Anon can read `amp_catalog`, `amp_catalog_facets`, `amp_shelf_map` and `amp_help_directory`, and nothing else.
- A logged-in non-staff user sees no staff rows and cannot change stock.
- Active staff can edit allowed metadata, call stock RPCs and manage other staff through the audited membership RPCs. They cannot write ledger or membership rows directly.
- The Worker key can call the three checkout RPCs and has no direct table access.
- A wrong checkout secret fails for reads and confirmations.
- Disabling a staff row, or deleting the Auth account, removes access on the next request. A recreated account needs deliberate relinking, not name matching.
- `app` is absent from the exposed schemas and nothing relies on automatic grants.
- The Worker maps errors correctly: stale count is a conflict, a retry never duplicates, bad quantity is a validation error, unauthorised is an access error.
- Rehearse app switching, lost connectivity after payment, staff recovery with a reason, a zero-total checkout, and the contact-retention client scanning every page and rechecking eligibility.

## 8. Bin/cabinet swaps and abandoned count batches

Races: duplicate simultaneous bin swaps; opposing swaps from stale forms; two bin inserts into one free cell; duplicate abandoned-batch closure; owner reactivation against abandoned closure.
Expected: one exchange; the stale swap fails with `STALE_BIN_POSITION`; the second insert waits on the cabinet row and fails with `BIN_POSITION_OCCUPIED`; one closure and one audit entry; a closure that waited on a reactivated owner fails.

## 9. Independent stale correction forms

Race: two forms read the same revision after a receipt of 60 and each submit a -10 linked correction with different request IDs.
Expected: one commits; the other fails with `STALE_STOCK_CORRECTION`. Received is 50, not 40.

## 10. Staff recovery racing the original browser

Race: `amp_recover_checkout` against the browser's confirmation of the same checkout.
Expected: one sale, one event, one withdrawal. If staff win, `recovered_by` and `recovery_reason` are kept and the browser cannot repost. Lost-credential recovery never creates a replacement checkout or an adjustment.

## 11. Corrections with recounts, and storage retirement

Races:

- After a receipt of 60 and a count of 10, a plain correction fails with `CORRECTION_REQUIRES_RECOUNT`. `amp_correct_movement_and_count` (-50, count 10) races a sale of one: if it wins, stock is 9 and received 10; if the sale wins, it fails with `STALE_STOCK_COUNT` and order history is untouched.
- Assigning a product to an empty bin against archiving that bin: the loser fails with `BIN_STILL_HAS_PRODUCTS` or `PRODUCT_BIN_UNAVAILABLE`.
- `amp_archive_empty_cabinet` with an old snapshot against a drawer insert: fails with `STALE_SHELF_LAYOUT`. Against an inactive product assignment, in both orders: as above. Duplicate retries give one result and one audit update per row.

Expected: no product ends up in retired storage, and no writer sees half of a correction/recount pair. `amp_archived_bin_locations` shows each drawer's position at its archive event even if the cabinet later moves.

## 12. Unsupported isolation for placement writes

Direct bin insertion and cabinet shrink at `REPEATABLE READ` fail with `READ_COMMITTED_REQUIRED` (not an overlap test). Bin insertion racing cabinet shrink, in both orders: the later one fails and no bin is left outside its grid.

## 13. Concurrent volunteer directory edits

Race: two staff forms read one contact at revision 1; A publishes and holds, B edits the name with the same revision.
Expected: B waits, then updates zero rows; A's publication and revision 2 stand. The UI keeps B's draft and asks for review, never retrying with a new revision.

## 14. Saving complete drawer layouts

Races against `amp_save_shelf_layout`, each expecting the waiting side to fail cleanly:

- Same request ID twice: one cabinet with its drawers, same result.
- Two edits of one snapshot: the second fails with `STALE_SHELF_LAYOUT`.
- A drawer insert or move commits first: the layout fails with `STALE_SHELF_LAYOUT` and never moves a drawer back. In the other order, the insert fails with `BIN_POSITION_OCCUPIED` and a guarded move updates zero rows.
- A product assignment against removing or absorbing its drawer: the layout fails with `LAYOUT_HAS_PRODUCTS`, or the assignment fails with `PRODUCT_BIN_UNAVAILABLE`. An expanded drawer keeps its products either way.

The layout RPC locks drawers in UUID order, then the cabinet, and never takes product locks after drawer locks; product assignment share-locks its target drawer. Keep these orders when extending placement operations. Non-overlapping layout rules are in `supabase/tests/shelf-layout.sql`.

## 15. Staff access changes

Races use real separate sessions and wait for an observed lock overlap:

- Two active members deactivate each other, in both orders: the first succeeds, and the waiting member fails with `STAFF_REQUIRED`. The winner stays active and the failed request leaves no retry record.
- Deactivation wins over the target member granting access: the waiting grant fails with `STAFF_REQUIRED` and creates no member. This also applies when the first caller uses the maintainer revoke helper.
- Duplicate invitation grants with one request ID: both return the same staff ID; exactly one membership and audit insert exist.

`supabase/tests/staff-management.sql` additionally covers self/final-member protection, normalization, retry payload and actor binding, reactivation without history loss, active-member name preservation, deleted Auth identities, audit attribution, and anonymous/service/non-staff/disabled access denial. Supabase Auth delivery and full Worker/browser invitation behavior require the real Auth checks in §7.
