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

## 3. Checkpoint and apply

For a populated project, first rehearse the migration on an isolated restored
snapshot with before/after row comparisons. An incompatible cutover must stop
all writes, including from open or offline clients, using this barrier.

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
restore. Use a libpq service entry (`PGSERVICE=ampoteket-reviewed-target`) that
matches §2, with TLS and credentials from the secret store. Never put
credentials in Git, logs or command arguments. Never run fixtures, acceptance
or concurrency tests against production.

```sh
PGSERVICE=ampoteket-reviewed-target psql -X -v ON_ERROR_STOP=1 -f supabase/tests/permissions.sql
PGSERVICE=ampoteket-reviewed-target psql -X -v ON_ERROR_STOP=1 -f supabase/tests/protections.sql
PGSERVICE=ampoteket-reviewed-target psql -X -v ON_ERROR_STOP=1 -f supabase/tests/v1-invariants.sql
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

Enter products and opening stock through count batches, following the
[counting procedure](operating-procedures.md). No invented receipts or hidden
counters. Every active product needs `last_counted_at`. A second person
spot-recounts bins; resolve differences before launch. Save the opening
inventory/placement manifest and check physical labels.

## 6. Worker and Auth

`wrangler.jsonc` defines the Worker name, assets, checkout rate limits and
`ADMIN_INVITATION_LIMIT`. Use the locked Wrangler (`bunx --no-install`), check the account with
`wrangler whoami`, and record the Cloudflare zone/account. Add the reviewed
public values before building:

```jsonc
"vars": {
  "PUBLIC_SUPABASE_URL": "https://<reviewed-project>.supabase.co",
  "PUBLIC_SUPABASE_PUBLISHABLE_KEY": "<reviewed-publishable-key>",
  "CHECKOUT_ALLOWED_ORIGIN": "https://ampoteket.no",
  "SALES_OPEN": "false"
},
"routes": [{ "pattern": "ampoteket.no", "custom_domain": true }]
```

`SALES_OPEN` stays `"false"` (shop shown as opening soon) until the people who
administer sales are ready; set it to `"true"` and redeploy to open buying.
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
`bunx --no-install wrangler secret put RESEND_API_KEY` (a sending-only key is
enough) and keep the `RECEIPT_LIMIT` binding from `wrangler.jsonc`. Without either,
purchases still work but the receipt form reports that sending failed.

### Publish

```sh
bun run build
bunx --no-install wrangler deploy --dry-run
bunx --no-install wrangler secret put SUPABASE_SECRET_KEY
bunx --no-install wrangler deployments list
bunx --no-install wrangler deploy
bunx --no-install wrangler deployments list
```

Review the dry run's bindings and assets. Enter the secret at the prompt, never
as an argument; if Wrangler offers to create the Worker, confirm account and name. Record the previous deployment ID before publishing and the new
one after. Every deploy must carry the full vars, routes and rate-limit
bindings; do not rely on dashboard-only values. The custom domain needs the
zone in the same Cloudflare account and no conflicting DNS record; confirm the
certificate before opening. `workers_dev` is off.

## 7. Release verification and recovery

Before opening the shop, take the first independent backup and finish a restore
drill. Rehearse phone → Vipps → registration, retries and lost network on
isolated stock. Record revision, Worker version, config/secret names, project,
domain, results and backup ID. Smoke-check both locales, catalog, help, Auth
and rejection of cross-origin checkout; never register test purchases in real
stock.

If verification fails, turn the Data API off again first. If the previous
Worker is compatible with the schema, roll back to it:

```sh
bunx --no-install wrangler rollback '<previous-worker-version-id>' \
  --message 'Release verification failed; see the deployment record'
```

Rollback does not restore the database, secrets or config; reconcile those
against the record. Old checkout credentials and retries must stay compatible. For schema/data failures, keep writes closed and follow the
pre-decided forward-fix or [restore](runbook-backup-restore.md). Keep logs and
the failed target. Never edit history to make checks pass; version every
emergency fix.
