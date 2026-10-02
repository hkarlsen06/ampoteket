# Ampoteket backup and restore runbook

A restore must keep original rows, identities, timestamps, revisions, audit
images, retry results and sequence state. Never replay a data-only dump into an
initialized app with triggers enabled: they would reset metadata and invent
audit history.

## 1. Decisions required before launch

Primary operator: **Hjalmar Karlsen (`hkarlsen06`)**, assigned by the owner on
2026-10-02 for service access, backups and contact retention. An independent backup
operator is still unassigned. The recovery targets and arrangements below remain
unagreed; record them here when accepted.
RPO is how much recent data the team can afford to re-enter; RTO is how long the
shop can be down. Choose them before choosing backup frequency or a plan.

| Decision | Required record |
| --- | --- |
| Responsible people | Hjalmar Karlsen is primary; name an independent secondary operator and escalation path, then both verify access |
| Recovery point (RPO) | Maximum acceptable data loss; backup frequency must meet it |
| Recovery time (RTO) | Maximum acceptable outage; measured restore time must meet it |
| Backup storage | Independent location, encryption key custody, retention, restore/delete access |
| Scheduled checks | Backup frequency, failed/overdue alert recipient, drill schedule and owner |
| External services | Supabase/Cloudflare/domain billing, recovery and succession of access |

Suggested, **not adopted**: 24-hour RPO and RTO; a monitored daily encrypted
off-platform backup; two admins who can each restore it; a full drill before
launch, each semester and after major schema or operator changes. Provider
[backups](https://supabase.com/docs/guides/platform/backups) depend on the plan.
A backup without an accessible key, tested reader or alert recipient does not
count. Recheck owners at every handover.

## 2. Contents and consistency

Include `app`, public API objects, Auth records with original UUIDs,
`supabase_migrations`, sequences, policies/grants, and the repository revision
and migration hashes. Record project, PostgreSQL/CLI versions, UTC cutoff,
checksums and manifests with each backup.

Dumps are sensitive (Auth data, buyer contacts). Erased contacts survive in
older backups: track erasures and reapply them after a restore.

Separate dump commands only match if nothing writes in between. For a release
checkpoint, use the [cutover barrier](runbook-deploy.md#enforced-cutover-barrier),
pause Auth and owner administration, and keep it until reopening. The Data API
toggle does not stop Auth sign-in; if that cannot be stopped, use a provider
backup and take its manifest from an isolated restored copy.

## 3. Back up and restore

Follow the [Supabase CLI procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Check the dump `--dry-run` output lists the Auth and app tables and sequences.
Never echo credentials or enable shell tracing. Link the source project, freeze
it (§2), then:

```sh
umask 077
supabase db dump --linked --role-only --file roles.sql
supabase db dump --linked --file schema.sql
supabase db dump --linked --data-only --use-copy --file data.sql
supabase db dump --linked --schema supabase_migrations --file history-schema.sql
supabase db dump --linked --schema supabase_migrations --data-only --use-copy --file history-data.sql
PGSERVICE=ampoteket-backup-source python3 scripts/database-manifest.py > source-manifest.json
sha256sum roles.sql schema.sql data.sql history-schema.sql history-data.sql source-manifest.json > SHA256SUMS
```

Restore into an empty, separate Supabase project. Do **not** run Ampoteket's
initializer first. Keep any role-ownership edits beside the original dumps.
Never ignore SQL errors or accept a missing table. Point the service entry only
at the destination:

```sh
PGSERVICE=ampoteket-isolated-restore psql -X --single-transaction -v ON_ERROR_STOP=1 \
  -f roles.sql -f schema.sql -f history-schema.sql \
  -c 'SET LOCAL session_replication_role = replica' \
  -f data.sql -f history-data.sql \
  -c 'SET LOCAL session_replication_role = origin'
```

This also skips foreign-key checks, so §5 is mandatory before reopening. If the
restore fails, keep diagnostics and rebuild the destination from scratch.
Provider [restore-to-new-project](https://supabase.com/docs/guides/platform/clone-project)
is an alternative; it needs manual settings recovery and the same checks.

## 4. Identity and configuration recovery

Keep Auth UUIDs; historical staff IDs never change. If an Auth account cannot be
restored:

1. Verify the person explicitly; a display name or date is not proof.
2. Record `old staff ID / old Auth UUID → new Auth UUID`, evidence, reason,
   approver and UTC time in the access record.
3. With access disabled, relink in a transaction that checks the old value and
   changes exactly one row.
4. Re-enable only that person and test the real login.

Never give a new volunteer a departed person's staff identity.

Restore and review: public-only API exposure, disabled signup, Auth URLs and
mail, Worker endpoint and secret, DNS, deployed revision, rate/origin limits and
backup alerts. Record secret names, not values. A new project has new keys; test
staff, non-staff and guest access before cutover.

## 5. Reconciliation before reopening

Keep writers stopped. The manifest holds counts, row hashes and sequence state,
no personal data. Review any Auth difference individually.

```sh
PGSERVICE=ampoteket-isolated-restore python3 scripts/database-manifest.py > restored-manifest.json
diff -u source-manifest.json restored-manifest.json
PGSERVICE=ampoteket-isolated-restore psql -X -v ON_ERROR_STOP=1 -f supabase/tests/permissions.sql
PGSERVICE=ampoteket-isolated-restore psql -X -v ON_ERROR_STOP=1 -f supabase/tests/protections.sql
PGSERVICE=ampoteket-isolated-restore psql -X -v ON_ERROR_STOP=1 -f supabase/tests/v1-invariants.sql
```

Require exact rows, staff/Auth mappings and sequences. Compare schema and
history with the migration files. Reconcile stock per product, order progress
per line and checkout totals per checkout.

In a drill, also test: staff login; non-staff refusal; an old request retry;
checkout retry and resume with saved tokens (synthetic, never logged); one new
stock operation and edit (exactly one new ledger/audit entry); ledger edits
rejected.

Then record elapsed time, cutoff and writes after it. Reapply contact erasures,
restore configuration and reopen only once verified. Keep the old environment
until recovery is accepted.

## 6. Drills

`./scripts/test-backup-restore.sh` runs a full local backup, restore and
comparison with synthetic Auth. It does not prove real Auth or platform
settings. Finish a full-stack drill after the opening-stock import and before
launch, then on the agreed schedule.

| UTC date | Operator / reviewer | Backup ID / source revision | Route / target | Row / identity checks | Duration / RPO-RTO met | Open actions |
| --- | --- | --- | --- | --- | --- | --- |
| `<first full-stack drill required before launch>` | | | | | | |
