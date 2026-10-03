# Volunteer procedures

Practise these physically before launch. Database rules are in
[datamodell.md](datamodell.md); screens are in [admin stock](page-admin-stock.md)
and [admin purchasing](page-admin-orders.md).

## Count one bin at a time

1. Tell people the bin is being counted. Pause taking and shelving there (other
   bins stay open). Register any known pending receipts, withdrawals or buyer
   purchases for its products first.
2. Count each product and post what you see while the pause holds. Zero is a
   real count; a skipped product is not zero. Do not change units to fit.
3. If the system reports stale stock, check the new movement and recount. Never
   resubmit the old number.
4. Resume once the counts are saved. Each count posts at once; closing the batch
   only ends the session.
5. If a late registration or movement turns up afterwards, register it normally,
   then pause and recount. Never guess an offset, delete the late sale or
   backdate it.

The system cannot know whether an item on a workbench was counted; a fresh
recount is always the fix.

## Correct an old receipt or other movement

Review the original event, its corrections and the order progress first. If
someone else corrects the same stock meanwhile, yours is rejected as stale:
review again rather than repeating it.

- **No count since the movement:** use the normal linked adjustment.
- **Any count since** (even a matching one): use **correct and recount**. Pause
  and count the bin, enter the correction and a reason (a receipt of 60 that
  should be 10 is −50), and submit both together.

The original receipt stays, order progress is fixed, and the new count becomes
the stock. A failure changes nothing. After a timeout, retry the same request;
it will not apply twice.

## Help a buyer who lost their checkout

A registered purchase is not a verified payment.

1. Find the original checkout by checkout ID or prepare request ID, then check
   its items, total, time and the buyer's story. A contact, name or similar cart
   is not enough. Do not show unrelated contacts while searching.
2. If it is ambiguous, stop and investigate. Never create a replacement checkout
   or manual withdrawal "just in case"; the original may still be confirmed.
3. If already registered, that is the answer. Otherwise use recovery with a short
   non-sensitive reason. A later browser retry reuses the same sale and cannot
   withdraw twice.
4. If the bin was counted since the items were taken, recount it.

See [checkout-recovery.md](checkout-recovery.md) for when this path is needed.

## Free items

A zero total works: the buyer uses "Complete purchase", skips Vipps, and stock is
withdrawn with no payment claim. Which products are free is a pricing decision.

## Storage changes

To retire storage, move or unassign every product in the bin (inactive ones
too; deactivate a product before removing its required bin), archive the
empty bins, then the empty cabinet. History is kept; archived
storage leaves the public shelf map.

To change a drawer layout, use Admin → Cabinets and drawers
([details](page-admin-stock.md#cabinets-and-drawers)). Move all assigned products first
before shrinking or splitting a drawer. After a stale-layout message, compare the
map with the real cabinet before editing again.

## Contacts and data checks

- Unconfirmed checkouts mean "not registered", not "unpaid"; they are kept.
- Contacts on unconfirmed checkouts are cleared after 90 days
  ([retention runbook](runbook-contact-retention.md)). Never copy contacts into
  notes, logs or URLs.
- Run the read-only [invariant check](../supabase/tests/v1-invariants.sql) after
  a restore, schema change or suspected data problem, and save its findings
  before fixing anything. Also compare physical counts: a consistent database
  can still hold a wrong entry.

## Volunteer directory

Agree each published name and contact method with its owner. Enter it in
`/admin/help`, check `/contact` and `/en/contact`, and test the link or number on a
phone. At handover, unpublish outdated contacts; never reuse an entry for a
different person.

## Ownership to name before launch

Assign owners for accounts, project, domain and Worker; staff onboarding and
removal; contact cleanup; backups, restore and incidents. Record backup
frequency, RPO and RTO in the [backup runbook](runbook-backup-restore.md) §1. A
local restore test does not prove production backups exist.
