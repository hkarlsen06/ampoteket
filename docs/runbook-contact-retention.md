# Optional checkout-contact retention

Buyers may leave an optional contact detail with a checkout. On an unconfirmed
checkout it is deleted 90 × 24 hours after the checkout was made. Confirmed
checkouts are outside this rule; staff erase those on request. Checkouts, sales
and stock history are kept. Until the cutover ([cutover runbook](runbook-cutover.md))
production runs on Supabase, where this was a manual procedure (git history,
`git show b83c41e:docs/runbook-contact-retention.md`).

## Automatic clearing

`convex/crons.ts` runs `retention.clearExpiredContacts` every day at 02:15 UTC (at
night in Oslo). Each run deletes up to 100 expired contacts, each on a checkout
without a sale and created more than 90 × 24 hours earlier, and schedules the next
batch at once when it cleared a full 100, until none are left. Each batch is one
transaction: an interrupted batch changes nothing, and finished batches stay done.
A contact that expires after tonight's run is cleared the next night, so the delay
past 90 days is at most about a day.

Each deletion is audited in the same transaction as `CONTACT_CLEARED` on
`checkout_contacts` with the checkout ID, actor empty (the system, database role
`convex`) and no contact text. Nobody needs to run anything.

## Checking that it ran

- Convex dashboard, production deployment: the cron job "clear expired checkout
  contacts" under Schedules shows its last runs, and Logs shows each
  `retention:clearExpiredContacts` execution and any error. From a shell, with the
  deploy key as in [reaching the hosted project](runbook-deploy.md#reaching-the-hosted-project):
  `bunx --no-install convex logs --history 200 --success`.
- The admin change log (`/admin/audit`) shows the clearances as "Contact detail
  cleared" without a person.

A run that fails is retried by the next night's run, which picks up everything
still expired. If failures repeat, the operator (**Hjalmar Karlsen**, assigned on
2026-10-02) investigates from the logs; running
`bunx --no-install convex run retention:clearExpiredContacts` with the deploy key
starts the same batch chain by hand and prints the first batch's count.

## Individual erasure

When a buyer asks, staff find the checkout at `/admin/purchases` and use **Erase
contact detail**, which calls `checkout.clearContact`. It works on confirmed and
unconfirmed checkouts, keeps the purchase, and is audited as `CONTACT_CLEARED`
with the staff member as actor and without the text. Never copy contacts into
notes, logs or URLs.

## After a restore

An older snapshot still holds contacts that were cleared after it was taken.
Before reopening, erase again every contact cleared by staff after the snapshot,
and let the next nightly run (or a manual run, above) clear the expired ones
([restore runbook](runbook-backup-restore.md) §5).
