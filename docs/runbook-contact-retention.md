# Optional checkout-contact retention

Optional contacts on unconfirmed checkouts are cleared after 90 × 24 hours.
Confirmed checkouts are outside this rule; individual erasure uses
`amp_clear_checkout_contact`. Checkouts and stock history are kept.

Use the owner connection from
[reaching the hosted project](runbook-deploy.md#reaching-the-hosted-project),
without the read-only option, since this writes. Check
the target and that **your own** Auth UUID is an active staff member. Never use
another volunteer's UUID or invent one; it is the audit record of who ran it.

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v operator_auth_user_id='<your verified active Auth UUID>' \
  -f scripts/clear-expired-contacts.sql
```

Each run clears up to 100 and prints the count.

- Rerun until it prints `0`.
- A timeout or error exit is a failed batch, not completion.
- `CONTACT_RETENTION_RETRY_REQUIRED` or a lock timeout (five seconds): rerun.
- After an interruption, just rerun; finished batches stay committed.

It is safe alongside checkout confirmation and recovery. Each clearance is
audited as `CONTACT_CLEARED` without the text.

This is manual. **Hjalmar Karlsen** is the operator, assigned on 2026-10-02.
Before launch, agree the schedule (daily keeps the delay to about a day) and set
a reminder. Log every run, including
zero results, without contact text or checkout IDs:

| UTC due / run time | Reviewed target | Operator | Batch counts and total | Exit status / retry or escalation |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

A failed batch needs follow-up. After restoring an older backup, reapply later
erasures before reopening. The regression test is
`supabase/tests/contact-retention.py`.
