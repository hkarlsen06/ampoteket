# Current validation

What has been executed, and what must still happen before launch. All runs used
local, disposable services, except the provider checks and approved hosted
release recorded below.
Past runs live in git history, not here. Replace a row when you rerun it; do not
append a diary. CI runs the database chain and the `boundary`, `shop`, `checkout`,
`admin`, `admins`, `scanner`, `labels` and `statistics` browser modes; the results
below are local runs, not CI claims.

## Executed checks

| Check | Last run | Result | Covers |
| --- | --- | --- | --- |
| `bun run check`, `bun run check:scripts`, `bun run lint` | 2026-10-06 | PASS, 0 errors/warnings | Types, scripts, lint |
| `bun run build` | 2026-10-05 | PASS | Production SvelteKit/Cloudflare bundle with the admin professionalism fixes |
| `bun test` | 2026-10-06 | PASS, 254 tests, 2,119 assertions | Unit tests, including CI/deploy failures, HTTPS headers, seed cleanup ownership, account-bound password changes, receipt retries and Discord deadlines/cooldowns |
| `bun audit` | 2026-10-02 | PASS, no reported vulnerabilities | Resolved dependency tree |
| `python3 scripts/test-check-clipped-ink.py`, `bun run check:ink` | 2026-10-02 | PASS | Checker regressions, static SVG checks |
| `./scripts/test-database.sh` | 2026-10-06 | PASS | Ten migrations, rollback/retry, ACLs/RLS, acceptance, 12 stored-data corruption cases including drawer bounds/overlap, 42 concurrency scenarios including competing help-order writes, restore, schema/docs comparison, signed-JWT HTTP |
| GitHub Actions Validation | 2026-10-02 | PASS, all nine jobs on the deployed application revision `d2a5485` | Database and all eight browser modes; [release CI](https://github.com/hkarlsen06/ampoteket/actions/runs/36975296467) (scanner passed on rerun after a CI hang) |
| GitHub Actions Deploy | 2026-10-02 | PASS, version `d1ffbf47-c54d-4f85-b555-b3c786f5883c` | First deploy from `.github/workflows/deploy.yml`: CI gate, reviewed vars/rate limits/secret names, HSTS, `/contact` and HTTP redirect checks by `deploy:production`; [run](https://github.com/hkarlsen06/ampoteket/actions/runs/36976781424) |
| Hosted release verification | 2026-10-02 | PASS | Reviewed vars/rate limits/secret names; 25 HTTP checks across both locales, HTTP/www redirects, HSTS, private admin/checkout headers, closed sales; persisted error logs with query redaction and invocation logs off |
| Actual-snapshot migration rehearsal | 2026-10-06 | PASS | Private hosted checkpoint (07:44 UTC) restored locally with owners/ACLs; the CLI applied `20261006000100` and `20261006000200`; only `app.units`, `app.audit_log` and `app.audit_log_id_seq` changed (declared), 49 other app/Auth tables and two sequences unchanged; prior eight history rows unchanged, two new rows; permissions, protections and invariants passed. Owned container removed. This is not the full hosted recovery drill |
| Audit fix browser acceptance | 2026-10-02 | PASS | Real disposable Auth/PostgREST: active unplaced product in shelf/count picker; invitation password save and independent sign-in; cross-tab account switch removes password form and preserves both passwords; help reorder/focus, stale rejection and retry. No overflow at 360 px (password/help) or 1280 px (shelf/count). Owned seed and dev server removed after verification |
| `./scripts/test-web.sh` | 2026-10-01 | PASS | Real local Auth, public/staff/Worker boundaries, exact decimal transport |
| `./scripts/test-web.sh --shop` | 2026-10-01 | PASS | Lifecycle freshness, retained drafts, invalid saved quantities, removal focus, mobile drawer addresses |
| `./scripts/test-web.sh --checkout` | 2026-10-01 | PASS | Remote staff recovery, pre-payment recheck and navigation during it, framing protection, Auth invitation/recovery emails in Mailpit |
| `./scripts/test-web.sh --admin` | 2026-10-03 | PASS | Access recovery, retained cached content, partial-inventory retry, stock field validation, audit freshness with older pages retained, drawer resizing, specification error focus |
| `./scripts/test-web.sh --admins` | 2026-10-01 | PASS | Real Auth/Worker/Mailpit invitations in both locales, password setup/login, permissions and audit, replay/stale-resend safeguards, 360/1280 px in both locales/themes, retained drafts/focus on read failure, deactivation/reactivation |
| `./scripts/test-web.sh --statistics` | 2026-10-01 | PASS | Localized responsive charts, retained data and focus after a failed background read |
| `./scripts/test-web.sh --scanner` | 2026-10-01 | PASS | Firefox and WebKit with synthetic camera; named long-content scrolling keeps Add/Scan visible |
| `./scripts/test-web.sh --labels` | 2026-10-06 | PASS | Decoded PDF QR payloads, geometry |
| `./scripts/test-web.sh --shelf` | 2026-10-03 | PASS | Shelf UI: grid grips, drawer actions beside the selected drawer, drag/grip moves and swaps, archive guards, cabinet move to a vacant wall position |
| `./scripts/test-web.sh --drafts` | 2026-10-03 | FAIL | Stops at its first step, the new-order draft: the order form now opens two lines, so the `Product` combobox locator is ambiguous. The shelf layout and catalog search steps passed when run on their own. Unsaved admin drafts survive reload, Back and sign-in round trips |
| `./scripts/test-web.sh --orders` | 2026-10-02 | PASS | Field errors and first-invalid focus, receipt freshness with selection retained, access recovery inside a pending sheet, identical uncertain-write retry, exact stock changes, New order checklist of parts needing ordering adds and removes lines |
| Browser geometry, automated | not recorded | PASS | 320×256, 667×375 and 844×390 viewports, both locales, reduced motion, 100-character category, 120-character supplier token, full accessible warning description on confirmations |
| Browser geometry, manual | not recorded | PASS | Homepage in both locales/themes at 320/360/768/1280 px; specification and admin scanner dialogs at 360×320; short dialogs, product pickers, long text, dense shelf targets, enlarged hero text; `ShelfCabinetFace` viewBox reviewed (fill-only drawers, no clipped strokes) |
| iOS 27 Simulator (Safari) | not recorded | PASS | 440×956 and 956×440: rotation, keyboard, native shelf panning |

Limits of this evidence: the static ink checker only lists dynamic geometry for manual review,
short-viewport checks do not prove physical phone keyboard behaviour, and the
simulator is not physical-device coverage. Android emulation was unavailable
(missing SDK).

## Migrations and schema surface

Update this section whenever a migration changes (`sha256sum supabase/migrations/*`).

- `20260917000100_ampoteket_initial.sql`: SHA-256
  `0eda5217b038887d44b1960983f7df650f6ba44458bb1f05f5f5808b5e99c69b`
- `20260924000100_archive_empty_cabinet.sql`: SHA-256
  `503d75885d3774a967f4cad7a3b891b94b4f62020a393d5620220a997be6b7d6`
- `20260927000100_staff_management.sql`: SHA-256
  `a894879c2707f3d11542aed1131f4245e8445e433122ed1ef0416a4157edfde8`
- `20261001000100_help_contact_discord.sql`: SHA-256
  `f7bcedb3b2e2f7a03455c06664e4e97833b00fe7b07f004ba29255bdd73b673a`
- `20261001000200_volunteer_contacts.sql`: SHA-256
  `7b0888d92f33d4c5927abc81249230d7763012e625268de26d34c59fcc3239ba`
- `20261001000300_help_contact_order.sql`: SHA-256
  `99c58f4e01fda5334d07698c889f40e9207fb302afd7687839215e22545af76c`
- `20261002000100_guard_help_contact_order.sql`: SHA-256
  `884bc671e2ceec8c346a00121bf0168d346e716bdb0f7c4111b5bafde520d6dc`
- `20261004000100_single_count_product.sql`: SHA-256
  `25904328be34292b3a959f27b62018c3ac06a6ee12b4413c45c3ed09621148a2`
- `20261006000100_gram_unit.sql`: SHA-256
  `2d48d9687355724cda060e9982f2953c249abef0537d19f98fe6b7f54b779013`
- `20261006000200_catalog_compact_measurements.sql`: SHA-256
  `6ecb9d6548ba035c25196cc766decdaf6db5a0ab5f74184f33d4db245f06f2de`

24 app tables, four exact numeric domains, 30 public RPCs, 29 staff views and five
internal derived views. All views are security invoker; only `public` is exposed.
Initial data: 12 cabinets, 492 drawers, reference units and 12 published volunteer
contacts; no products or stock.

A 5,002-product / 250,000-movement workload checks that catalog reads touch only
the selected products. It is a regression check, not a hosted latency guarantee.

## Open checks before launch

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
- **Hosted setup:** the approved audit fixes from commit `959ea2e` passed all nine
  CI jobs and were deployed with `bun run deploy:production` as Worker version
  `c577fda5-a502-4a56-80b4-e2e21e67721b` at 04:00 UTC on 2026-10-02.
  One attempt automatically rolled back after its HTTP check failed; the
  unchanged retry and an independent HTTP client passed. The original failed
  response was not recorded, so its cause is unproven. The expected four vars,
  four rate limits and both secret names match. Both locales passed the 25
  public/private/closed-route HTTP checks; sales remain closed. See
  [current state](AGENTS.md#current-state). Hosted Auth configuration matches
  SMTP, signup, Site URL, localized return URL and template requirements.
  A real invitation and password reset reached an OsloMet (Microsoft 365) mailbox
  on 2026-10-01; the reset set a password. Buyer receipt delivery,
  receipt-archive access, aligned message headers and DMARC enforcement remain
  unverified. The global Data API
  cutover barrier and full hosted recovery drill remain open
  ([deploy](docs/runbook-deploy.md), [backup](docs/runbook-backup-restore.md)).
- **Hosted migration and release:** with the owner's approval, CLI 2.116.0 applied
  `20261006000100_gram_unit.sql` and `20261006000200_catalog_compact_measurements.sql`
  at 07:45 UTC on 2026-10-06. Linked history matches all ten local versions. The
  isolated rehearsal above passed on a checkpoint taken a minute before.
  `permissions.sql`, `protections.sql` and `v1-invariants.sql` passed against the
  hosted project afterwards. Read-only checks found units `g`, `m` and `pcs`, one
  new migration-made audit row for `g`, the compact-measurement match in
  `app.catalog_matches` with its owner-only privileges, and 0 products, 4 active
  staff members and 0 checkouts. Both migrations are additive: the deployed
  frontend needs neither. The global cutover barrier was not needed; the hosted
  recovery drill remains open.
- **Repository and monitoring controls:** CI gating, deployment rollback, HTTPS
  and error-log changes are live. Provider settings confirm persisted logs with
  invocation logs off and query strings redacted. The reviewed native main-protection
  policy is `.github/main-protection.json`. On 2026-10-02 the owner approved and
  the provider APIs confirmed all nine required GitHub Actions checks, admin
  enforcement, linear history, blocked force pushes/deletion, vulnerability
  alerts, automated security fixes, secret scanning and push protection. On
  2026-10-04 the owner removed the required checks from main protection. See
  [provider controls](docs/runbook-deploy.md#repository-protection-and-monitoring).
  Verify an actual error/uptime notification path before launch.
- **Owners and targets:** Hjalmar Karlsen (`hkarlsen06`) is the primary operator
  for service access, backups and contact retention, assigned on 2026-10-02.
  An independent backup operator, RPO/RTO, backup storage, retention reminder,
  alert recipient and drill schedule remain open. The backup runbook proposes
  24 hours each, daily off-platform backups and a drill each semester; these
  targets and arrangements have not been accepted.
