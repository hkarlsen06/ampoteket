# Cutover runbook: Supabase to Convex

The one-time move of production from Supabase to Convex. The owner decides when
it happens; sales close for the window (about 30 minutes). Every step lists who
does it. Nothing here deletes or changes the Supabase project: it stays as it was
at the export and is the rollback.

What moves: every application table (products, specifications, the wall, the
stock ledger, orders, counts, checkouts with their contacts, sales, help
contacts, staff, command records and the whole audit log) and the five Auth
identities with their bcrypt password hashes. Admins keep their passwords; they
sign in once more, because sessions do not move.

## 1. Before the window (owner, once)

1. **Convex project.** Create a Convex account and a project named `ampoteket`.
   Its production deployment gets a name like `happy-otter-123`; the URL is
   `https://happy-otter-123.convex.cloud`. Choose the EU region if offered: the
   data includes buyer contacts and staff email addresses.
2. **Deploy key.** In the Convex dashboard, Settings → Deploy key → production.
   Store it as the GitHub secret `CONVEX_DEPLOY_KEY` in the `production`
   environment, and keep a local copy for the import (never in the repository).
3. **Convex environment variables** (dashboard → Settings → Environment
   variables, or `bunx convex env set` with the deploy key):

   | Name | Value |
   | --- | --- |
   | `JWT_PRIVATE_KEY`, `JWKS` | Set by `CONVEX_DEPLOY_KEY='<prod key>' bun scripts/convex-cutover/auth-keys.ts`, which generates a fresh key pair and writes both to the deployment; nothing to copy. |
   | `SITE_URL` | `https://ampoteket.no` (invitation and reset links). |
   | `CHECKOUT_SERVER_KEY` | 64 random hex characters (`openssl rand -hex 32`). The Worker gets the same value. |
   | `RESEND_API_KEY` | A Resend API key allowed to send from `notify.ampoteket.no`. |

   Never set `ALLOW_TEST_FIXTURES` in production: it enables test-only functions.
4. **Worker secret.** `bunx --no-install wrangler secret put CHECKOUT_SERVER_KEY --env production`
   with the same value. Keep `RESEND_API_KEY` (receipts). `SUPABASE_SECRET_KEY`
   is removed after the cutover is verified (§4).
5. **Export access.** Either link the Supabase CLI on this machine
   (`supabase link --project-ref mqzcbdorjuefefzvuefa`) or have the session pooler
   connection string ready for `AMPOTEKET_EXPORT_DATABASE_URL`. The export only
   reads.

## 2. Rehearsal (owner or a session the owner trusts; days before)

Use a separate Convex **development** deployment of the same project, never the
production one.

```sh
scripts/convex-cutover/export.sh                      # read-only; prints the file path
CONVEX_DEPLOY_KEY=<dev deploy key> bunx convex deploy   # functions to the dev deployment
CONVEX_URL=https://<dev>.convex.cloud CONVEX_ADMIN_KEY=<dev deploy key> \
  bun scripts/convex-cutover/import.ts <export.json>
```

The import must end with `Verified: every table, the stock projection and every
product balance match the export.` Then sign in against the dev deployment with
your own password (`PUBLIC_CONVEX_URL=https://<dev>.convex.cloud bun --bun run dev`)
and compare a few products, the shelf map and the change log with the live site.
Delete the export afterwards.

## 3. The window (owner)

1. **Close sales.** On `main`: set `SALES_OPEN` to `"false"` in `wrangler.jsonc`,
   commit, push, and wait for the deploy (`gh run watch`). Tell volunteers not to
   edit stock, products or the shelf until sales reopen; there is no technical
   lock for staff.
2. **Deploy the functions** to the empty production deployment, from the
   migration branch: `CONVEX_DEPLOY_KEY=<prod key> bunx convex deploy`.
3. **Export:** `scripts/convex-cutover/export.sh`. One read-only snapshot.
4. **Import and verify:**

   ```sh
   CONVEX_URL=https://<prod>.convex.cloud CONVEX_ADMIN_KEY=<prod deploy key> \
     bun scripts/convex-cutover/import.ts <export.json>
   ```

   It refuses a deployment that already holds data. Any `VERIFICATION FAILED`
   line stops the cutover: go to §5.
5. **Merge.** On the migration branch: set `PUBLIC_CONVEX_URL` in `wrangler.jsonc`
   to the production URL, keep `SALES_OPEN` `"false"`, and rewrite the
   [Current state](../AGENTS.md#current-state) rows for Site, Hosted database
   (now Convex: deployment name, region, import date and counts) and Email
   (Convex sends invitations and resets through Resend). Rebase onto `main`,
   fast-forward `main`, push. Validation runs, then Deploy pushes the Convex
   functions (unchanged) and publishes the Worker.
6. **Verify live**, with sales still closed:
   - Sign in at `https://ampoteket.no/admin/login` with your existing password.
   - The product list, a product's stock history, the shelf map, orders and the
     change log show the same data as before.
   - `bun scripts/verify-live.ts` passes.
   - Request a password reset for your own address and follow the link.
7. **Reopen sales:** `SALES_OPEN` `"true"`, commit, push. Make one small real
   purchase only if the owner wants a live checkout check; it changes real stock.
8. **Clean up:** delete the export file. Remove the Worker secret
   `SUPABASE_SECRET_KEY` (`wrangler secret delete … --env production`). Pause the
   Supabase project rather than deleting it; deleting it is a separate owner
   decision once Convex has run for a while.

## 4. After the cutover

- Contact retention runs by itself every night (`convex/crons.ts`); the manual
  procedure is retired ([runbook](runbook-contact-retention.md)).
- Backups: Convex keeps its own; take an owner-held snapshot as described in
  [runbook-backup-restore.md](runbook-backup-restore.md).
- Commands that a browser still held as "pending" from before the window carry
  Supabase-era request digests; a retry of one is refused as
  `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` rather than applied twice. Staff
  re-enter that one action. Closing sales and pausing staff work beforehand keeps
  this to none.

## 5. Rollback

Until sales reopen, nothing has been written to Convex except the import, and
Supabase still holds the same data:

1. Revert `main` to the commit before the merge (`git revert` the merge range, or
   push the previous tip as a new commit) and push; Deploy republishes the
   Supabase version.
2. Reopen sales there. Leave the Convex deployment as it is for investigation.

After sales reopen on Convex, a rollback would lose every purchase, count and
edit made since; reconcile those by hand from the Convex change log first.
