# Ampoteket backup and restore runbook

A restore must keep original rows, identities, timestamps, revisions, audit
images, retry results and sequence state. On Convex, a snapshot export holds every
table as it was at one moment, including the Auth tables, `counters` (the gap-free
movement and audit sequences) and `stock_levels`, and a snapshot import puts them
back unchanged. Never rebuild data by re-entering it through the application: that
would invent audit history and new revisions.

Until the cutover ([cutover runbook](runbook-cutover.md)) production runs on
Supabase; its backup procedure is in git history
(`git show b83c41e:docs/runbook-backup-restore.md`).

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
| Recovery point (RPO) | Maximum acceptable data loss; snapshot frequency must meet it |
| Recovery time (RTO) | Maximum acceptable outage; measured restore time must meet it |
| Backup storage | Independent location, encryption key custody, retention, restore/delete access |
| Scheduled checks | Snapshot frequency, failed/overdue alert recipient, drill schedule and owner |
| External services | Convex/Cloudflare/Resend/domain billing, recovery and succession of access |

Suggested, **not adopted**: 24-hour RPO and RTO; a monitored daily encrypted
owner-held snapshot; two admins who can each restore it; a full drill before
launch, each semester and after major schema or operator changes. Convex also
keeps its own backups (dashboard, Backups); what it keeps depends on the plan, and
the owner-held snapshot is ours. A backup without an accessible key, tested reader
or alert recipient does not count. Recheck owners at every handover.

## 2. Contents and sensitivity

A snapshot is one ZIP with a folder per table. It holds buyer contacts, staff email
addresses, bcrypt password hashes, session and refresh-token records and checkout
token digests: treat it like a password store. It does not hold the deployed
functions or the deployment's environment variables; those come from the
repository commit and the deployment record.

Record with each snapshot: UTC time, source deployment name, repository commit
deployed at that time, file size and SHA-256.

Erased contacts survive in older snapshots. After a restore, reapply every
erasure made after the snapshot (§5).

## 3. Take a snapshot

With the production deploy key read as in
[reaching the hosted project](runbook-deploy.md#reaching-the-hosted-project),
write outside the repository, readable only by you:

```sh
(
  read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY
  umask 077 && mkdir -p ~/ampoteket-exports
  file=~/ampoteket-exports/"$(date -u +%Y-%m-%dT%H%M%SZ)-convex-snapshot.zip"
  bunx --no-install convex export --path "$file"
  sha256sum "$file"
)
```

The export only reads; sales and staff work continue. Encrypt the file with a key
the owner holds, move the encrypted copy to the agreed storage (§1), check that it
decrypts, and delete the plain file. Never commit, share or attach a snapshot.

## 4. Restore

Always restore into a separate rehearsal deployment first (a development
deployment of the `ampoteket` project, as in the
[cutover rehearsal](runbook-cutover.md)), never straight into production. Give
the rehearsal deployment its own `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL`
(`bun scripts/convex-cutover/auth-keys.ts` prints a key pair) and leave
`RESEND_API_KEY` unset so no email leaves it.

1. Decrypt the snapshot into a private directory and check its SHA-256 against
   the record.
2. In one subshell with the **target's** deploy key read as in §3, deploy the
   functions of the commit recorded with the snapshot, so the target's schema
   matches the data, then import, replacing everything in the target:

   ```sh
   bunx --no-install convex deploy
   bunx --no-install convex import --replace-all '<snapshot.zip>'
   ```

   `--replace-all` deletes the target's existing data, including tables missing
   from the snapshot; it asks for confirmation first. Never pass `--yes` against
   production.
3. Run the checks in §5 on the target.

Restoring production itself is the owner's decision, made only after the
rehearsal passes. Close sales (`SALES_OPEN` `"false"` in `wrangler.jsonc`, push)
and pause staff work first; every write since the snapshot is lost. If the
restore goes into a new deployment instead, it needs the production environment
variables ([deploy runbook](runbook-deploy.md) §3), `PUBLIC_CONVEX_URL` in
`wrangler.jsonc` and the GitHub secret `CONVEX_DEPLOY_KEY` must change to it, and
admins sign in again.

### Identity recovery

Staff identities restore with the data: `staff_members.auth_user_id` refers to
`users.auth_user_id`, which the snapshot keeps. Historical staff IDs never change.
If one person's account cannot be restored:

1. Verify the person explicitly; a display name or date is not proof.
2. Record `old staff ID / old Auth UUID → new Auth UUID`, evidence, reason,
   approver and UTC time in the access record.
3. Keep that membership deactivated until the relink is reviewed. No function
   relinks a membership; never edit `auth_user_id` in the dashboard data view,
   which bypasses the audit log. The owner decides how to apply it.
4. Re-enable only that person and test the real sign-in.

Never give a new volunteer a departed person's staff identity.

## 5. Checks before reopening

Keep sales closed and staff paused. With the target's deploy key:

```sh
bunx --no-install convex run migration:verifyStockLevels
```

It must print `[]`: every product's stock level and revision match its ledger. For
each application table, `bunx --no-install convex run migration:tableDigest
'{"table":"products"}'` gives the row count and a digest; the counts must equal the
line counts of `<table>/documents.jsonl` in the snapshot. Then:

- An admin signs in with their existing password; a deactivated member gets no
  admin access; the change log, a product's stock history, the shelf map and orders
  show the expected data.
- In a drill, also test an old request retry (returns its stored result), a
  checkout retry and resume with saved tokens (synthetic, never logged), one new
  stock operation and edit (exactly one new movement and audit entry).
- Reapply contact erasures made after the snapshot: the source's change log, if
  still readable, lists them as `CONTACT_CLEARED` entries after the snapshot time;
  otherwise use the erasure requests on record. Erase each again at
  `/admin/purchases`. Expired contacts are cleared by the next nightly retention
  run ([contact retention](runbook-contact-retention.md)).
- Check the Convex environment variable names, the Worker vars and secrets, DNS and
  the deployed commit against the record. Record names, not values.

Record elapsed time, snapshot time and the writes lost after it. Reopen only once
verified. Keep the old deployment until recovery is accepted.

## 6. Drills

No restore drill has been executed on Convex. The cutover import's verification
([cutover runbook](runbook-cutover.md)) is not a drill of this procedure. Finish a
full drill, from a real production snapshot into a rehearsal deployment, before
relying on it, then on the agreed schedule. Executed evidence belongs in
[VALIDATION.md](../VALIDATION.md); record each drill there with operator, snapshot
time and source commit, target, check results, duration and whether RPO/RTO were
met.
