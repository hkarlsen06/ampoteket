# Ampoteket deployment runbook

Releasing and operating production: the Cloudflare Worker `ampoteket` in front of
the Convex production deployment. Hosted changes need an explicit deployment
decision; all other work stays local and disposable. The one-time move from
Supabase is owned by the [cutover runbook](runbook-cutover.md); until it has run,
production still uses Supabase, and its connection and migration procedures are in
git history (`git show b83c41e:docs/runbook-deploy.md`).

## 1. Prepare the exact release

1. Commit the changes. Run `bun run check`, `bun run check:scripts`, `bun run lint`,
   `bun test`, `./scripts/test-convex.sh`, `bun run build` and the browser proofs in
   `README.md` that the change touches. CI and `VALIDATION.md` must agree.
2. Start a deployment record: commit, operator, UTC time, Convex deployment name
   and the live Worker version (`bunx --no-install wrangler deployments list --env production`).
3. Have the real-API checks in [concurrency-tests.md](concurrency-tests.md) and
   the production acceptance in [website-guide.md](website-guide.md) §9 ready;
   real sign-ins, email and phones are not covered by the disposable suites.
4. Before launch, complete the decisions in
   [backup/restore](runbook-backup-restore.md) §1.
5. Order backend before Worker. A release deploys the Convex functions first and
   then publishes the Worker ([Publish](#publish)), so a frontend may use a new
   function or field in the same push. The reverse needs care, because Convex has no
   rollback: the new backend serves the old Worker while the new one publishes, and
   it stays if the Worker is rolled back. Every backend change must therefore keep
   working with the previously deployed Worker:
   - Add functions, arguments and result fields; do not rename or remove ones the
     live Worker or open browser tabs call. Remove them in a later release, once no
     deployed frontend uses them.
   - A schema change must accept every existing document. Convex refuses to deploy
     a schema the stored data does not match, so a new field starts optional (or
     nullable) and is filled through audited functions before it becomes required.
   - To undo a backend change, push a revert commit; it deploys forward like any
     release. A revert that tightens the schema fails while documents still use
     the newer shape.

## 2. Verify the target

`deploy:production` refuses a deploy key for any deployment other than the one
`PUBLIC_CONVEX_URL` in `wrangler.jsonc` names, and a Worker other than
`ampoteket`. Before a first deploy, a secret change or an unusual release, also
check by hand:

- The Convex dashboard shows project `ampoteket` and the production deployment
  whose URL is `PUBLIC_CONVEX_URL`. Record its name and region.
- Its environment variables are the ones in §3, and `ALLOW_TEST_FIXTURES` is
  absent: `bunx --no-install convex env list --names-only` with the deploy key, as below.
- `bunx --no-install wrangler whoami` shows the Cloudflare account that owns the
  `ampoteket.no` zone; record the account.

### Reaching the hosted project

The Convex project `ampoteket`, production deployment named in
`PUBLIC_CONVEX_URL`. The CLI targets the deployment of the deploy key in
`CONVEX_DEPLOY_KEY`: the production key from the Convex dashboard (Settings, Deploy
key), the same value as the GitHub `production` secret. It is an admin key: it can
run internal functions, change environment variables and replace data. Keep it out
of Git, `.env` files, logs and command arguments.

| Need | Method |
| --- | --- |
| Data, function runs, logs, cron runs, environment variables, Convex backups | Convex dashboard, project `ampoteket`, production deployment |
| Read-only checks from a shell | `bunx --no-install convex run <internal query>` (for example `migration:verifyStockLevels`) or `bunx --no-install convex run --inline-query '<read-only query>'` |
| Function logs | `bunx --no-install convex logs --history 100` (add `--success` for successful runs too) |
| Environment variable names | `bunx --no-install convex env list --names-only` |
| Owner-held snapshot | `bunx --no-install convex export`, see the [backup runbook](runbook-backup-restore.md) |
| Worker versions, logs, secrets | `bunx --no-install wrangler … --env production` with the Wrangler login; [diagnosing production](#diagnosing-production) |

Run CLI commands in a subshell that reads the key without echoing it, so the key
dies with the subshell:

```sh
(
  read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY
  bunx --no-install convex run migration:verifyStockLevels
)
```

Read-only checks are fine. Writes, imports and deletions happen only at the
owner's explicit request, and then through the application: staff changes in the
admin UI, under the person's own sign-in, so they are audited with an actor.
Never edit, add or delete documents in the dashboard's data view, and never
`convex import` into production outside a decided restore: both bypass
`convex/lib/audit.ts` and the ledger projection (`stock_levels`). Never run
`seed:*`, `fixtures:*` or `migration:*` writes against production; the cutover
import is the only exception ([cutover runbook](runbook-cutover.md)).

## 3. Convex environment variables

Set in the dashboard (Settings, Environment variables) or with
`bunx --no-install convex env set NAME`, which prompts for the value so it stays
out of shell history. First values and their generation are in the
[cutover runbook](runbook-cutover.md) §1.

| Name | Purpose |
| --- | --- |
| `JWT_PRIVATE_KEY`, `JWKS` | Convex Auth signs and verifies staff sessions with this pair. |
| `SITE_URL` | `https://ampoteket.no`: the origin of invitation and reset links and of the email header image. |
| `CHECKOUT_SERVER_KEY` | At least 32 characters, the same value as the Worker secret; without a match every guest checkout call fails with `CHECKOUT_SERVER_REQUIRED`. |
| `RESEND_API_KEY` | Sends invitation and reset email. |

`CONVEX_SITE_URL` is built in. `ALLOW_TEST_FIXTURES` and `EMAIL_API_URL` are for
disposable test backends only and are never set in production: the first enables
test-only functions, the second redirects email to a stub.

## 4. Checks after a backend release

`deploy:production` verifies the Worker, not the data. After a release that
changed `convex/`, with the deploy key as in
[reaching the hosted project](#reaching-the-hosted-project):

- `bunx --no-install convex logs --history 100` shows no new errors.
- `bunx --no-install convex run migration:verifyStockLevels` prints `[]`: every
  stock level matches its ledger.
- The admin pages the change touches load for a signed-in staff member, and the
  public catalog and `/contact` show data in both locales.

Never run fixtures, seeds, test suites or test purchases against production.

## 5. First staff member and opening stock

Production staff come from the cutover import, which keeps every admin's account
and password ([cutover runbook](runbook-cutover.md)). After that, admins invite,
reactivate and deactivate other admins at `/admin/admins`; onboarding needs no
dashboard or CLI. Membership changes are attributed to the signed-in admin, and
self-deactivation is forbidden, so at least one active admin always remains. A
forgotten password is reset from the sign-in page.

`seed:staff` creates a member with a password given as a command argument. It is
for fresh development and test deployments only; never run it on production.
Replace deleted accounts only through the verified mapping in the
[restore runbook](runbook-backup-restore.md) §4.

Enter opening stock either in the new-product form, which posts it as a count
([product editor](page-admin-stock.md)), or through count batches for products that
already exist, following the [counting procedure](operating-procedures.md). No
invented receipts or hidden counters. Every active product needs `last_counted_at`. A second person
spot-recounts bins; resolve differences before launch. Save the opening
inventory/placement manifest and check physical labels.

## 6. Worker and Auth

`wrangler.jsonc` holds the reviewed production settings in `env.production`: the
Worker name `ampoteket`, the vars `PUBLIC_CONVEX_URL`, `CHECKOUT_ALLOWED_ORIGIN`
and `SALES_OPEN`, the `ampoteket.no` and `www.ampoteket.no` custom domains (www
redirects to the apex) and the rate limits `CHECKOUT_SESSION_LIMIT`,
`CHECKOUT_OPERATION_LIMIT` and `RECEIPT_LIMIT`. The top level is local only
(`ampoteket-local`, no vars), so `vite dev` and `wrangler dev` never read hosted
settings and a deploy without `--env production` cannot replace the live Worker.
Use the locked Wrangler (`bunx --no-install`) and check the account with
`wrangler whoami`.

`SALES_OPEN` set to `"true"` opens buying; anything else shows the shop as opening
soon. Change it in `wrangler.jsonc` and push: every deploy replaces the vars, so a
dashboard edit lasts only until the next one.

The Worker secrets are `CHECKOUT_SERVER_KEY` (the same value as the Convex
variable) and `RESEND_API_KEY` (buyer receipts). They are never `vars` entries or
build arguments. Enter them at the prompt, never as an argument:

```sh
bunx --no-install wrangler secret put CHECKOUT_SERVER_KEY --env production
```

To rotate `CHECKOUT_SERVER_KEY`, set the Convex variable and then the Worker
secret, preferably while sales are closed: in between, checkouts fail with
`CHECKOUT_SERVER_REQUIRED`. A rehearsal Worker uses its own name, domain, Convex
deployment and secrets, never production credentials.

### Auth email

Convex sends staff invitations and password resets itself, through the Resend
API (`convex/lib/email.ts`, templates in `convex/lib/emailTemplates.ts`), from
`Ampoteket <noreply@notify.ampoteket.no>`. It needs the Convex variables
`RESEND_API_KEY` and `SITE_URL`; there are no hosted Auth email settings to
configure.

- Links go to `<SITE_URL>[/en]/admin/password?next=/admin&token_hash=…&type=invite|recovery`.
  Invitations last 7 days, resets 1 hour; a new link voids the person's earlier
  unused ones. The header image loads from `<SITE_URL>/brand/wordmark-email.png`,
  so `SITE_URL` must be the production origin.
- Opening a link spends nothing; setting the password does. Mail scanners
  (Microsoft 365 Safe Links on `oslomet.no`) open links first.
- Without a working key, an invitation reports `INVITATION_EMAIL_FAILED` but the
  membership is saved, so an admin retries delivery once the sender works. A reset
  request gives the same answer either way and sends nothing.

Buyer receipts are sent by the Worker with its own `RESEND_API_KEY` secret (a
sending-only key is enough) and the `RECEIPT_LIMIT` binding. Without them,
purchases still work, but the receipt form reports that sending failed and the
staff archive gets no copies.

Verify `notify.ampoteket.no` in Resend before sending. After checking real
invitation, reset and receipt headers for aligned DKIM/SPF, publish one TXT record
at `_dmarc.notify.ampoteket.no` with value `v=DMARC1; p=reject; adkim=r; aspf=r`.
This covers the sending subdomain without changing mail policy for other
`ampoteket.no` addresses. Verify the published record and delivery again. DNS
changes require the zone owner's approval and access; Resend's verified-domain
badge does not establish a DMARC policy.

### Publish

Every push to `main` on GitHub deploys production automatically through the
GitHub Actions workflow `.github/workflows/deploy.yml`. It starts when the
push-triggered Validation run (`.github/workflows/database.yml`) for that commit
succeeds, skips a commit that is no longer `main`'s tip, runs one deploy at a time
without cancelling a running one, and runs `bun run deploy:production` in the
GitHub environment `production` with two secrets:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare user API token for this account with *Edit
  Cloudflare Workers* permissions, including the `ampoteket.no` zone for the
  custom domains.
- `CONVEX_DEPLOY_KEY`: the production deploy key of the Convex deployment that
  `PUBLIC_CONVEX_URL` names.

A failed deploy can be retried from the Actions tab with **Re-run jobs**. The
Cloudflare Git integration (Workers Builds) is disconnected; do not reconnect it,
since it also builds every branch as a preview without production settings. A bare
`wrangler deploy` ships the top-level, var-less config. To deploy by hand, with
`CONVEX_DEPLOY_KEY` exported as in
[reaching the hosted project](#reaching-the-hosted-project) and the Wrangler login,
use only:

```sh
bun run deploy:production
```

`scripts/deploy-production.ts` does this, in order:

1. Refuses uncommitted changes, reads `env.production` and requires the Worker
   name `ampoteket`.
2. Requires a production deploy key (`prod:<name>|…`) for the deployment
   `PUBLIC_CONVEX_URL` names (`https://<name>.convex.cloud`, or
   `https://<name>.<region>.convex.cloud`); otherwise nothing is deployed.
3. Checks up to 20 times, 45 seconds apart, through the public GitHub API without
   a token, for the **push-triggered Validation run on that exact commit** to
   succeed. Failed, cancelled or skipped CI, an API error (including rate limits)
   or a timeout stops before anything is deployed. A commit must be pushed and
   validated before a manual deploy.
4. Rechecks the clean tree and unchanged commit after waiting, runs
   `bun run build`, and rechecks again.
5. Records the live Worker version; production must be one version at 100%.
6. Deploys the Convex functions (`convex deploy --yes`). If the commit changed
   meanwhile, it stops without publishing the Worker; the functions stay deployed.
7. Publishes the Worker (`wrangler deploy --env production` with the commit as
   message) and requires a new live version.
8. Verifies that version: every `env.production` var with its reviewed value, the
   three rate limits (namespace, limit, period), the secrets `CHECKOUT_SERVER_KEY`
   and `RESEND_API_KEY`, that `/contact` answers with the contact list and HSTS
   `max-age=31536000`, and that `http://ampoteket.no/admin/login` redirects to
   HTTPS. Health requests have a 15-second deadline.
9. On any failure in steps 7–8, including network and metadata errors, rolls the
   Worker back to the recorded version. A failed rollback reports both errors and
   the previous version for manual recovery. The command exits non-zero on any
   failed deployment.

The rollback covers only the Worker. Convex has no rollback, so the new functions
stay live under the previous Worker; that is why §1 requires backend changes to
keep working with it. The script does not check Convex environment variables, nor
that the two `CHECKOUT_SERVER_KEY` values match.

Never deploy or `wrangler versions upload` to `ampoteket` any other way: on
2026-10-01 a version uploaded without the production vars made the help page and
staff login unavailable while every page still loaded. The top-level `keep_vars`
only softens a mistaken `wrangler deploy`.

For a first Worker deploy, review the bindings and assets with
`bunx --no-install wrangler deploy --env production --dry-run` before
`deploy:production`. If Wrangler offers to create the Worker, confirm account and
name. The custom domain needs the zone in the same Cloudflare account and no
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
logs and redacts query strings, including password-link tokens. Convex keeps its
own function logs (dashboard Logs). Do not add logging of request bodies,
authorization headers, checkout secrets, password links or buyer contacts.
Hjalmar Karlsen owns inspection/escalation. A notification recipient and monitored
uptime/error alert must still be verified in the providers before launch.

### Diagnosing production

Every Wrangler command for the live Worker needs `--env production`; without it
Wrangler targets the local-only `ampoteket-local`.

```sh
bun scripts/verify-live.ts                                          # read-only HTTP smoke check, both locales
bunx --no-install wrangler deployments list --env production        # which version is live
bunx --no-install wrangler versions view '<version-id>' --env production   # its vars, bindings, secret names
bunx --no-install wrangler tail --env production --status error     # live Worker errors
```

On the Convex side, with the deploy key as in
[reaching the hosted project](#reaching-the-hosted-project):

```sh
bunx --no-install convex logs --history 100   # recent function logs and errors
bunx --no-install convex env list --names-only
```

The Convex dashboard shows the same logs, per-function failures and the cron
runs ([contact retention](runbook-contact-retention.md)).

Check the live vars first: pages that load but show "Unavailable", or a broken
staff login, usually mean a Worker version without the production vars or with the
wrong `PUBLIC_CONVEX_URL` ([Publish](#publish)). Checkout errors with
`CHECKOUT_SERVER_REQUIRED` in the Convex logs mean the Worker secret and the Convex
variable differ. An invitation that reports `INVITATION_EMAIL_FAILED` points at
`RESEND_API_KEY` or `SITE_URL` in Convex ([Auth email](#auth-email)). A function
error right after a push usually means a backend change the running Worker or an
open tab did not expect (§1). Persisted Worker error logs are in the Cloudflare
dashboard under the `ampoteket` Worker's Logs.

## 7. Release verification and recovery

Before opening the shop, take the first owner-held snapshot and finish a restore
drill ([backup runbook](runbook-backup-restore.md)). Rehearse phone → Vipps →
registration, retries and lost network on isolated stock. Record commit, Worker
version, Convex deployment, config and secret names, results and snapshot. Run
`bun scripts/verify-live.ts` and the checks in §4, then check the catalog, staff
sign-in and rejection of cross-origin checkout by hand; never register test
purchases in real stock.

If verification fails and `deploy:production` has not already rolled back, roll
the Worker back to the previous version:

```sh
bunx --no-install wrangler rollback '<previous-worker-version-id>' --env production \
  --message 'Release verification failed; see the deployment record'
```

A Worker rollback does not change the Convex functions, data, environment
variables or Worker secrets; reconcile those against the record. Fix a backend
fault forward with a new commit (a revert is one). For a data fault, close sales
(`SALES_OPEN` `"false"`, push), pause staff work, and choose between an audited
correction and a [restore](runbook-backup-restore.md); a restore loses every
later write. Keep logs. Never edit history to make checks pass; version every
emergency fix.
