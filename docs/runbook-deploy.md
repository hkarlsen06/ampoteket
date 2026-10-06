# Ampoteket deployment runbook

For first installation and later releases. Hosted changes need an explicit
deployment decision; all other work stays local and disposable.

## 1. Prepare the exact release

1. Commit the changes. Run `./scripts/test-database.sh`, `bun run check`,
   `bun run check:scripts`, `bun test`, `bun run build` and the browser modes in
   `README.md`. CI, migration hashes and `VALIDATION.md` must agree.
2. Start a deployment record: commit, `sha256sum supabase/migrations/*.sql`,
   operator, UTC time, target project reference, migration versions. Never edit
   a deployed migration; add and test a forward migration.
3. Have the real-HTTP protocol in [concurrency-tests.md](concurrency-tests.md)
   ready; real Auth and Worker/browser behaviour need a full-stack rehearsal.
4. Before launch, complete the decisions in
   [backup/restore](runbook-backup-restore.md) §1.
5. Order schema before code. Every push to `main` deploys the Worker, so a
   frontend that reads a new column, view or RPC must not reach `main` until its
   migration is applied (§3). Push the migration commit first, apply it, then push
   the frontend; the old frontend must keep working on the new schema meanwhile.

## 2. Verify the target

Compare the dashboard project reference, organisation and name with the record.
Use Supabase CLI **2.116.0**.

- Region **North EU (Stockholm)**, PostgreSQL **17**.
- Exposed Data API schema **`public` only**; automatic exposure **OFF**.
- Public Auth signups **DISABLED**.
- First install: no existing `app` schema or `public.amp_*` objects. A reused
  target needs a separately reviewed migration plan.
- Later deploys: installed versions match the released migrations. Unexpected
  history or schema stops the deployment.

```sh
amp_project_ref='<reviewed project reference>'
supabase link --project-ref "$amp_project_ref"
supabase migration list --linked
supabase db push --linked --dry-run --skip-vault
```

Check the pending filenames against the record. Bare `supabase migration up`
targets **local**, so always pass `--linked`. Never use `--include-all` to hide
divergent history.

### Reaching the hosted project

Project reference `mqzcbdorjuefefzvuefa`. No `PGSERVICE` entries exist; use these.
Credentials stay out of Git, logs and command arguments.

| Need | Method |
| --- | --- |
| SQL checks, manifests, §4 tests | `psql` with the linked CLI's temporary login, below |
| Read-only SQL from a Claude session | Supabase connector `execute_sql` also works; it returns no `NOTICE`s, so end a check with `SELECT 'PASS'` |
| Owner-approved writes | The same `psql` login without the read-only option. The Supabase connectors refuse destructive SQL |
| Auth, SMTP, templates, exposed schemas | Management API `https://api.supabase.com/v1/projects/<ref>/config/auth` and `/postgrest`, bearer token from `~/.config/ampoteket/supabase-token` (owner's machine) |
| Migration history | `supabase migration list --linked` (§2) |
| Worker versions, logs, secrets | `bunx --no-install wrangler … --env production` with the Wrangler login; [diagnosing production](#diagnosing-production) |

The linked CLI hands out a short-lived login (`cli_login_postgres`). Run this in a
subshell so the variables, password included, die with it; rerun it when the
password expires:

```sh
(
  eval "$(supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
  export PGOPTIONS='-c role=postgres -c default_transaction_read_only=on'
  psql -X -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM app.products'
)
```

Leave out `default_transaction_read_only=on` only for a write the owner asked for,
and wrap it in `BEGIN`/`COMMIT`.

## 3. Checkpoint and apply

For a populated project, first rehearse the pending migrations on the actual
data. The checkpoint holds Auth data and buyer contacts: keep it under the
ignored `test-results/`, never share it, and delete it after the release.

```sh
(
  eval "$(supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
  umask 077 && mkdir -p test-results/rehearsal
  pg_dump --format=custom --role=postgres --schema=app --schema=public --schema=auth \
    --schema=supabase_migrations --schema=extensions --file=test-results/rehearsal/checkpoint.dump
)
python3 scripts/rehearse-migration.py test-results/rehearsal/checkpoint.dump
```

The script restores the checkpoint into a private local container, applies the
migrations its history lacks with the CLI, and requires unchanged rows, sequences
and earlier history, then passing permissions, protections and invariants. A
migration that changes rows on purpose names exactly those tables and sequences
with `--expect-changed`; an audited insert into `app.units` is
`app.units,app.audit_log,app.audit_log_id_seq`. Its log and summary go next to the
checkpoint. This is not the hosted restore drill.

A migration that old clients survive (new functions, guarded replacements,
additive columns) needs no global barrier: apply it, then push its frontend
(§1). If verification fails, keep the affected action unavailable and
forward-fix rather than restoring unrelated production data. An incompatible
cutover must stop all writes, including from open or offline clients, using this
barrier.

### Enforced cutover barrier

1. Announce the outage. Pause operator SQL and Auth administration. Record
   successful read-only Data API probes with the public key, a staff JWT and the
   Worker secret, separately.
2. In Dashboard → Integrations → Data API, turn **Enable Data API** off. This
   blocks all REST access, including Worker checkout, regardless of grants
   ([Supabase docs](https://supabase.com/docs/guides/api/securing-your-api#disable-the-data-api)).
   Do not rewrite grants or the exposed schema instead.
3. Repeat the three probes directly against the Supabase origin with operator-only
   curl config files (mode 0600, holding `apikey` and, for staff,
   `Authorization`). Each must now return the disabled-service response seen in
   rehearsal. DNS/TLS errors or an invalid JWT are not evidence.

   ```sh
   curl --config "$amp_probe_config" --silent --show-error \
     --output /dev/null --write-out '%{http_code}\n' \
     "$amp_supabase_origin/rest/v1/rpc/amp_catalog?p_limit=1"
   ```

4. On the owner connection, confirm API transactions have drained. An error
   stops the checkpoint until investigated:

   ```sql
   DO $$ BEGIN
     IF EXISTS (SELECT FROM pg_stat_activity
                WHERE usename = 'authenticator' AND xact_start IS NOT NULL
                  AND pid <> pg_backend_pid()) THEN
       RAISE EXCEPTION 'API transactions have not drained';
     END IF;
   END $$;
   ```

Keep the Data API off through backup, migration and reconciliation; Auth and
owner SQL stay paused too. Turning it back on reopens writes: do it only as the
reopening step, verify staff/public and Worker reads at once, and turn it off
again if that fails. Rehearse the barrier on an isolated hosted project before
launch.

### Apply

Before touching valuable data, name a tested recovery checkpoint and its UTC
cutoff, and decide when to forward-fix versus restore. A restore loses later
writes, so keep writes stopped while deciding.

```sh
supabase migration up --linked
supabase migration list --linked
```

If one of several pending files fails, earlier ones may already be committed:
inspect history and state before retrying. Never drop a committed schema, mark a
failed migration applied, or rerun the initializer SQL by hand.

## 4. Post-apply checks

Owner `psql` is only for documented checks, Auth provisioning and the rehearsed
restore. Connect as in [reaching the hosted project](#reaching-the-hosted-project),
after checking the link matches §2. Never run fixtures, acceptance or concurrency
tests against production. These three end in `ROLLBACK` but create temporary
tables, which a read-only session refuses, so in that subshell first
`export PGOPTIONS='-c role=postgres'`:

```sh
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/permissions.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/protections.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/v1-invariants.sql
```

These change nothing. Keep their output, compare counts with `VALIDATION.md`,
and check RLS on all app tables and the applied versions/hashes. On first
install `amp_catalog()` is empty. On later releases, reconcile catalog,
inventory, order progress, checkouts and staff links against the pre-change
state; an empty catalog is a failure. Repeat the non-destructive HTTP checks.
Never create test purchases in real stock.

## 5. First staff member and opening stock

Create and verify the person's Supabase Auth account, then on the owner
connection:

```sql
SELECT app.grant_staff_access('<verified real address>', '<display name>');
```

Record who granted the first access and why. Once signed in, admins invite,
reactivate and deactivate other admins at `/admin/admins`; ordinary onboarding
needs no dashboard or SQL. Membership changes are attributed to the signed-in
admin, and self-deactivation is forbidden.

Keep `app.grant_staff_access` and `app.revoke_staff_access` for bootstrap and
emergency maintainer recovery only; record the operator and reason. Deactivation
keeps rows and actor IDs. Replace deleted accounts only through the verified
mapping in the [restore runbook](runbook-backup-restore.md) §4.

Enter opening stock either in the new-product form, which posts it as a count
([product editor](page-admin-stock.md)), or through count batches for products that
already exist, following the [counting procedure](operating-procedures.md). No
invented receipts or hidden counters. Every active product needs `last_counted_at`. A second person
spot-recounts bins; resolve differences before launch. Save the opening
inventory/placement manifest and check physical labels.

## 6. Worker and Auth

`wrangler.jsonc` holds the reviewed production settings in `env.production`: the
Worker name `ampoteket`, the public Supabase URL and publishable key,
`CHECKOUT_ALLOWED_ORIGIN`, `SALES_OPEN`, the `ampoteket.no` and `www.ampoteket.no`
custom domains (www redirects to the apex) and the rate limits. The top level is
local only (`ampoteket-local`, no vars), so `vite dev` and `wrangler dev` never read
hosted settings and a deploy without `--env production` cannot replace the live
Worker. Use the locked Wrangler (`bunx --no-install`), check the account with
`wrangler whoami`, and record the Cloudflare zone/account.

`SALES_OPEN` set to `"true"` opens buying; anything else shows the shop as opening
soon. Change it in `wrangler.jsonc` and push: every deploy replaces the vars, so a
dashboard edit lasts only until the next one.
`SUPABASE_SECRET_KEY` is never a `vars` entry or build argument. A rehearsal
Worker uses its own name, domain, Supabase project and origin, with no
production credentials.

### Auth email and callbacks

Configure hosted Auth for the same HTTPS origin before granting staff access:

- Allowed return URLs: `/admin/password` and `/en/admin/password`. Public
  signup stays disabled.
- Copy the HTML and subjects of `supabase/templates/invite.html` and
  `recovery.html` into the hosted email-template settings; `config.toml` does
  not publish them.
  The header image loads from `{{ .SiteURL }}/brand/wordmark-email.png`, so the
  Site URL must be the production origin.
- Both templates need a localized `redirectTo` ending in `?next=...`, because
  the link appends the token to that query. The site's invitation endpoint sends
  the fixed localized password URL with `?next=%2Fadmin`. A manual first-admin
  invitation must use that same Auth admin invitation API return URL; a Dashboard
  invitation without it does not work.
- The password page accepts PKCE `code` callbacks, or `token_hash` with
  `type=invite` / `type=recovery`. It rejects implicit `#access_token` callbacks.
  It spends the single-use token only when the person presses Continue, because
  mail scanners (Microsoft 365 Safe Links on `oslomet.no`) open links first.
- The built-in sender only delivers to project-team addresses (about 2
  emails/hour, no SLA). Production needs
  [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). Rehearse real
  invitation and reset delivery before launch. SMTP is hosted Auth configuration,
  not an application setting. A failed invitation email keeps the membership so
  an admin can retry delivery after the sender is configured.

For Resend, first verify the sending domain in Resend. In Supabase Authentication
→ Email → SMTP Settings, enable custom SMTP and set host `smtp.resend.com`, port
`465`, username `resend` and the Resend API key as the password. Set sender name
`Ampoteket` and sender address `noreply@notify.ampoteket.no`, after
`notify.ampoteket.no` is verified. See the
[Resend Supabase SMTP guide](https://resend.com/docs/send-with-supabase-smtp).
For Auth emails the key belongs in hosted Auth's SMTP settings. Buyer receipts
are sent by the Worker itself, so also run
`bunx --no-install wrangler secret put RESEND_API_KEY --env production` (a sending-only key is
enough) and keep the `RECEIPT_LIMIT` binding from `wrangler.jsonc`. Without either,
purchases still work but the receipt form reports that sending failed and the
staff archive gets no copies.

After checking real invitation/reset/receipt headers for aligned DKIM/SPF, publish
one TXT record at `_dmarc.notify.ampoteket.no` with value
`v=DMARC1; p=reject; adkim=r; aspf=r`. This covers the sending subdomain without
changing mail policy for other `ampoteket.no` addresses. Verify the published
record and delivery again. DNS changes require the zone owner's approval/access;
Resend's verified-domain badge does not establish a DMARC policy.

### Publish

Every push to `main` on GitHub deploys production automatically through the
GitHub Actions workflow `.github/workflows/deploy.yml`. It starts when the
push-triggered Validation run for that commit succeeds, skips a commit that is no
longer `main`'s tip, and runs `bun run deploy:production` in the GitHub environment
`production` (deployments from `main` only) with the secret `CLOUDFLARE_API_TOKEN`:
a Cloudflare user API token for this account with *Edit Cloudflare Workers*
permissions, including the `ampoteket.no` zone for the custom domains. A failed
deploy can be retried from the Actions tab with **Re-run jobs**. The Cloudflare Git
integration (Workers Builds) is disconnected; do not reconnect it, since it also
builds every branch as a preview that has no Supabase settings. A bare
`wrangler deploy` ships the top-level, var-less config. To deploy by hand, use only:

```sh
bun run deploy:production
```

It refuses a dirty tree and checks up to 20 times, 45 seconds apart, for the
**push-triggered Validation workflow on that exact commit** to succeed.
It rechecks the clean tree and unchanged commit after waiting and after building.
GitHub reads use the public
API without a token. Failed/cancelled/skipped CI, API errors (including rate limits)
and a wait timeout stop before upload; retry once validation and the API are
available. A commit must be pushed to GitHub and validated before a manual deploy.

It builds, records the live version immediately before publishing, runs
`wrangler deploy --env production` with the commit as message, then checks that
the new version carries every `env.production` var with its reviewed value, the
rate-limit values and the `SUPABASE_SECRET_KEY`/`RESEND_API_KEY` secret names,
that `/contact` reads the contact list with HSTS, and that HTTP login redirects to
HTTPS. Network and metadata exceptions join HTTP/config failures in the rollback
path; health requests have a 15-second deadline. Rollback failure reports both
errors and the prior version for manual recovery. The command exits non-zero on
any failed deployment. Never deploy or `wrangler versions upload` to `ampoteket` any
other way: on 2026-10-01 a version uploaded without the
production vars made the help page and staff login unavailable while every page
still loaded. The top-level `keep_vars` only softens a mistaken `wrangler deploy`.

First deploy or secret rotation: enter secrets at the prompt, never as an
argument, then deploy:

```sh
bunx --no-install wrangler secret put SUPABASE_SECRET_KEY --env production
bunx --no-install wrangler deploy --env production --dry-run
```

Review the dry run's bindings and assets. If Wrangler offers to create the
Worker, confirm account and name. Do not rely on dashboard-only or command-line
values. The custom domain needs the zone in the same Cloudflare account and no
conflicting DNS record; confirm the certificate before opening. `workers_dev` is
off.

### Repository protection and monitoring

After the owner approves these hosted settings, apply the reviewed policy:

```sh
gh api --method PUT repos/hkarlsen06/ampoteket/branches/main/protection \
  --input .github/main-protection.json
gh api --method PUT repos/hkarlsen06/ampoteket/vulnerability-alerts
gh api --method PUT repos/hkarlsen06/ampoteket/automated-security-fixes
gh api --method PATCH repos/hkarlsen06/ampoteket \
  --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
```

The policy requires linear history and forbids force pushes/deleting main. It
requires no status checks or second reviewer, so the owner can push straight to
main; the Deploy workflow still deploys only a commit whose Validation passed. These
commands are an explicit hosted change, not part of a local setup or test run.

Production config enables persisted Worker error logs, omits routine invocation
logs and redacts query strings, including Auth callbacks. Do not add logging of
request bodies, authorization headers, checkout secrets or buyer contacts.
Hjalmar Karlsen owns inspection/escalation. A notification recipient and monitored
uptime/error alert must still be verified in the provider before launch.

### Diagnosing production

Every Wrangler command for the live Worker needs `--env production`; without it
Wrangler targets the local-only `ampoteket-local`.

```sh
bun scripts/verify-live.ts                                          # read-only HTTP smoke check, both locales
bunx --no-install wrangler deployments list --env production        # which version is live
bunx --no-install wrangler versions view '<version-id>' --env production   # its vars, bindings, secret names
bunx --no-install wrangler tail --env production --status error     # live errors
```

Check the live vars before anything else: pages that load but show "Unavailable"
or a broken staff login usually mean a version without the production vars
([Publish](#publish)). A missing column or RPC error after a push means the
frontend went out before its migration (§1). Persisted error logs are in the
Cloudflare dashboard under the `ampoteket` Worker's Logs.

## 7. Release verification and recovery

Before opening the shop, take the first independent backup and finish a restore
drill. Rehearse phone → Vipps → registration, retries and lost network on
isolated stock. Record revision, Worker version, config/secret names, project,
domain, results and backup ID. Run `bun scripts/verify-live.ts`, then check the
catalog, Auth and rejection of cross-origin checkout by hand; never register test purchases in real
stock.

If verification fails, turn the Data API off again first. If the previous
Worker is compatible with the schema, roll back to it:

```sh
bunx --no-install wrangler rollback '<previous-worker-version-id>' --env production \
  --message 'Release verification failed; see the deployment record'
```

Rollback does not restore the database, secrets or config; reconcile those
against the record. Old checkout credentials and retries must stay compatible. For schema/data failures, keep writes closed and follow the
pre-decided forward-fix or [restore](runbook-backup-restore.md). Keep logs and
the failed target. Never edit history to make checks pass; version every
emergency fix.
