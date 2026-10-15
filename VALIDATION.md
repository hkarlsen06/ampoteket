# Current validation

What has been executed, and what must still happen before launch. All runs used
local, disposable services, except the provider checks and hosted release recorded
below. Past runs live in git history, not here. Replace a row when you rerun it; do
not append a diary.

The backend moved from Supabase (PostgreSQL) to Convex. Production runs the
Supabase version until the cutover ([runbook-cutover.md](docs/runbook-cutover.md)).
Evidence that only described the PostgreSQL implementation (migration hashes, SQL
suites, PostgREST regressions, restore rehearsals, browser modes against a local
Supabase stack) is in git history up to commit `b83c41e`.

CI (`.github/workflows/database.yml`) runs check, lint, unit tests and
`./scripts/test-convex.sh`, then the `boundary`, `shop`, `checkout`, `admin`,
`admins`, `scanner`, `labels`, `statistics` and `news` browser modes. The results below
are local runs, not CI claims.

## Executed checks

| Check | Last run | Result | Covers |
| --- | --- | --- | --- |
| `./scripts/test-convex.sh` | 2026-10-17 | PASS, 40 tests in 10 files | Disposable local Convex backend with `convex/` deployed and type-checked; `tests/convex/` through the native client: accounts (invitation link and sign-in, failed email retry, alike refusals, no self-deactivation, maintainer grant and revoke), statistics (registered sales, per-line rounding, attention order), checkout (Worker key only, frozen prices, exactly-once confirmation, recovery, contact erasure and 90-day retention), concurrency (stale counts, duplicate confirmations, duplicate request IDs, many sales of one product, mutual deactivation), the Supabase import, orders, seed, shelf and help contacts, news (an article and its event saved together, retry-safe and revision-guarded saves under overlap, permanent unique slugs, one event per article, drafts and their images private, unpublishing takes images down, feed and calendar cursors, input and image checks, staff-only writes), stock (counts, steps, idempotent retries, corrections, projection equals ledger, count batches, non-staff refusal) |
| `./scripts/test-web.sh` and all 12 modes (`--shop`, `--checkout`, `--scanner`, `--admin`, `--admins`, `--statistics`, `--labels`, `--shelf`, `--orders`, `--drafts`, `--admin-help`, `--sidebar`) | 2026-10-17 | PASS, every mode in one sequential sweep; `--admins` then 4 more consecutive passes after the refresh-abort fix | The built Worker over trusted HTTPS against a disposable Convex backend in Firefox (WebKit too for the scanner): sign-in, refresh and revocation, the whole shop and checkout (exactly-once registration, staff recovery racing the buyer, lost responses), invitations and resets through the emailed single-use link, every admin screen including labels PDFs with decoded QR codes, counts, orders and statistics, at phone and desktop widths in both locales and themes |
| `./scripts/test-web.sh --news` | 2026-10-17 | PASS | The built Worker against a disposable Convex backend in Firefox: one editor creates an article and its event with a re-encoded image, a link and a tagged volunteer; a save whose response is lost is resent unchanged and stored once; `/en/news`, the article (image loaded, link, person), the month calendar, the event and the editor at 360 and 1280 px without horizontal scroll; the image endpoint's type and cache headers; unpublishing answers 404 for both pages and the image |
| Repository checks | 2026-10-17 | PASS | `bun run check` (0 errors), `bun run check:scripts`, `bunx eslint .`, `bun test` (274 pass, 41 backend cases skipped without a backend), `bun run check:dashes`, build under Bun (`bun --bun run build`). `bun audit`: `@auth/core` raised to 0.41.3 for its advisories; remaining findings are in `wrangler`'s `sharp` and `source-map-js`, unchanged from the Supabase version. Oxlint cannot load `oxlint.config.ts` under this machine's Node 22, so `bun --bun run lint` runs it (PASS) |
| Catalog read time | 2026-10-17 | 115 ms at 150 products, 720 ms at 1,000 | Uncached `catalog.page` on a quiet local backend against Convex's 1 s query limit; time grows with the number of active products, so revisit (a catalog projection) before the catalog nears 1,000 |
| `python3 scripts/test-check-clipped-ink.py`, `bun run check:ink` | 2026-10-02 | PASS | Checker regressions, static SVG checks |
| Hosted release verification | 2026-10-02 | PASS | On the Supabase-era Worker: reviewed vars/rate limits/secret names; 25 HTTP checks across both locales, HTTP/www redirects, HSTS, private admin/checkout headers, closed sales; persisted error logs with query redaction and invocation logs off |
| Browser geometry, automated | not recorded | PASS | 320×256, 667×375 and 844×390 viewports, both locales, reduced motion, 100-character category, 120-character supplier token, full accessible warning description on confirmations |
| Browser geometry, manual | not recorded | PASS | Homepage in both locales/themes at 320/360/768/1280 px; specification and admin scanner dialogs at 360×320; short dialogs, product pickers, long text, dense shelf targets, enlarged hero text; `ShelfCabinetFace` viewBox reviewed (fill-only drawers, no clipped strokes) |
| iOS 27 Simulator (Safari) | not recorded | PASS | 440×956 and 956×440: rotation, keyboard, native shelf panning |

Limits of this evidence: the static ink checker only lists dynamic geometry for manual review,
short-viewport checks do not prove physical phone keyboard behaviour, and the
simulator is not physical-device coverage. Android emulation was unavailable
(missing SDK).

## Open checks before launch

- **Convex cutover:**
  - The real-data import rehearsal on a separate Convex deployment
    ([runbook-cutover.md §2](docs/runbook-cutover.md#2-rehearsal-owner-or-a-session-the-owner-trusts-days-before)).
  - The cutover itself ([§3](docs/runbook-cutover.md#3-the-window-owner)).
  - Live sign-in in production with a password imported from Supabase.
  - Invitation and password-reset delivery from Convex through Resend to a real
    mailbox.
  - The backup and restore drill on Convex
    ([backup runbook](docs/runbook-backup-restore.md)).
- **CI on the Convex code:** the Validation workflow has not run on this branch;
  it runs on the pull request or the cutover merge.
- **Stock withdrawals/corrections:** real staff/non-staff browser write acceptance
  at 360 and 1280 px, including uncertain writes and a recount after an intervening
  count. Direct non-staff audit-page coverage.
- **Phones:** camera scanning, keyboard/safe areas and the Vipps app switch on real
  devices, plus scanning the attached paper QR ([checklist P01–P19](docs/scanner.md)).
  All P01–P19 cases are NOT RUN. The owner used the scanner on an iPhone on
  2026-09-20, but model, versions and cases were not recorded; Android and
  older/slower phones are untested. System-camera handling of scheme-less
  `ampoteket.no/p/...` QR text and homepage photographs on physical phones are
  unchecked.
- **Labels:** measure drawer label areas, print an A4 sheet, check size and cut
  margins, attach it to real drawers and scan it in the workshop's light. For the
  P-touch printer, a WebUSB print from the admin editor and scanning the printed
  tape QR with a phone.
- **Email:** in the Supabase era, a real invitation and password reset sent
  through Supabase Auth SMTP reached an OsloMet (Microsoft 365) mailbox on
  2026-10-01, and the reset set a password. That proves the Resend domain, not the
  Convex sender. Buyer receipt delivery, receipt-archive access, aligned message
  headers (DKIM/SPF) and DMARC enforcement remain unverified.
- **Repository and monitoring controls:** CI gating, deployment rollback, HTTPS
  and error-log changes are live. Provider settings confirm persisted logs with
  invocation logs off and query strings redacted. The reviewed native main-protection
  policy is `.github/main-protection.json`. On 2026-10-02 the owner approved and
  the provider APIs confirmed the required GitHub Actions checks, admin
  enforcement, linear history, blocked force pushes/deletion, vulnerability
  alerts, automated security fixes, secret scanning and push protection. On
  2026-10-04 the owner removed the required checks from main protection. See
  [provider controls](docs/runbook-deploy.md#repository-protection-and-monitoring).
  Verify an actual error/uptime notification path before launch.
- **Owners and targets:** Hjalmar Karlsen (`hkarlsen06`) is the primary operator
  for service access, backups and contact retention, assigned on 2026-10-02.
  An independent backup operator, RPO/RTO, backup storage,
  alert recipient and drill schedule remain open. The backup runbook proposes
  24 hours each, daily off-platform backups and a drill each semester; these
  targets and arrangements have not been accepted.
