# Current validation

What has been executed, and what must still happen before launch. All runs used
local, disposable services, except the hosted rehearsal recorded under Hosted setup.
Past runs live in git history, not here. Replace a row when you rerun it; do not
append a diary. CI runs the database chain and the `boundary`, `shop`, `checkout`,
`admin`, `admins`, `scanner`, `labels` and `statistics` browser modes; the results
below are local runs, not CI claims.

## Executed checks

| Check | Last run | Result | Covers |
| --- | --- | --- | --- |
| `bun run check`, `bun run check:scripts`, `bun run lint` | 2026-10-01 | PASS, 0 errors/warnings | Types, scripts, lint |
| `bun test` | 2026-10-01 | PASS, 226 tests | Unit tests |
| `bun audit` | 2026-09-30 | PASS, no vulnerabilities after the dependency update | Resolved dependency tree |
| `python3 scripts/test-check-clipped-ink.py`, `bun run check:ink` | 2026-09-30 | PASS | Checker regressions, static SVG checks |
| `./scripts/test-database.sh` | 2026-10-01 | PASS | Rollback/retry, ACLs/RLS, acceptance, filters, statistics, malformed input, 10 stored-data corruption cases (including duplicate sale movements), concurrency (including mutual admin deactivation, stale invitations), restore, schema/docs comparison, signed-JWT HTTP |
| `./scripts/test-web.sh` | 2026-10-01 | PASS | Real local Auth, public/staff/Worker boundaries, exact decimal transport |
| `./scripts/test-web.sh --shop` | 2026-10-01 | PASS | Lifecycle freshness, retained drafts, invalid saved quantities, removal focus, mobile drawer addresses |
| `./scripts/test-web.sh --checkout` | 2026-10-01 | PASS | Remote staff recovery, pre-payment recheck and navigation during it, framing protection, Auth invitation/recovery emails in Mailpit |
| `./scripts/test-web.sh --admin` | 2026-10-01 | PASS | Access recovery, retained cached content, partial-inventory retry, stock field validation, audit freshness with older pages retained, drawer resizing, specification error focus |
| `./scripts/test-web.sh --admins` | 2026-10-01 | PASS | Real Auth/Worker/Mailpit invitations in both locales, password setup/login, permissions and audit, replay/stale-resend safeguards, 360/1280 px in both locales/themes, retained drafts/focus on read failure, deactivation/reactivation |
| `./scripts/test-web.sh --statistics` | 2026-10-01 | PASS | Localized responsive charts, retained data and focus after a failed background read |
| `./scripts/test-web.sh --scanner` | 2026-10-01 | PASS | Firefox and WebKit with synthetic camera; named long-content scrolling keeps Add/Scan visible |
| `./scripts/test-web.sh --labels` | 2026-10-01 | PASS | Decoded PDF QR payloads, geometry |
| `./scripts/test-web.sh --shelf` | 2026-10-01 | PASS | Shelf UI |
| `./scripts/test-web.sh --drafts` | 2026-10-01 | PASS | Unsaved admin drafts survive reload, Back and sign-in round trips |
| `./scripts/test-web.sh --orders` | 2026-10-01 | PASS | Field errors and first-invalid focus, receipt freshness with selection retained, access recovery inside a pending sheet, identical uncertain-write retry, exact stock changes |
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
- **Hosted setup:** on 2026-10-01 (commit `e2f4096`, CI green) the first three
  migrations above were applied with `supabase migration up --linked` to project
  `mqzcbdorjuefefzvuefa` (Stockholm, PostgreSQL 17); history and hashes match.
  `permissions.sql`, `protections.sql` and `v1-invariants.sql` passed there; 24
  app tables all have RLS. Hosted Auth has public signup off, Site URL
  `https://ampoteket.no` and password return URLs for `https://ampoteket.no` (both
  locales, switched 2026-10-01 13:06 UTC), the repo email templates, and Data API
  schema `public` only. The Worker serves `ampoteket.no` and `www.ampoteket.no` (308
  to the apex, Google Trust Services certificate) as version
  `fe231e66-a89b-4457-b68f-63ac7ce4d490` (commit `634513d`, `--env production`, built
  from a clean worktree, deployed 2026-10-01 13:43 UTC, previous
  `2499119e-7eee-423b-be6d-fb24a69f28c9` from `551798a`; the workers.dev rehearsal
  address is off) with `SALES_OPEN=false`: `/`, `/en`, `/help`, `/privacy` and
  `/admin` answer 200, `/p`, `/cart`, `/checkout` and `/p/<code>` answer 503 "shop
  opens soon", and `POST /api/checkouts/session|prepare` answers
  `503 CHECKOUT_UNAVAILABLE`. `/api/discord` answered 30 of 30 calls over a minute after
  `634513d` (before it, 2 of 5 failed while Discord throttled Cloudflare egress). The first admin (`hjalmar@hkarlsen06.dev`, Hjalmar Karlsen) was
  granted with `app.grant_staff_access` by Claude Code at the owner's request. A test
  admin, "Hjalmar 2", whose Auth account had already been deleted and which no
  record referenced, was deleted by Claude Code at the owner's request on 2026-10-01,
  with the `keep_records` trigger disabled for that one transaction. Still
  open: custom SMTP
  invitation/reset delivery (the owner reports Resend connected as
  `Ampoteket <noreply@notify.ampoteket.no>`) and the receipt email are unverified; the Data API
  cutover barrier and a full hosted restore drill
  ([deploy](docs/runbook-deploy.md), [backup](docs/runbook-backup-restore.md)).
- **Volunteer Discord contacts:** `20261001000100` and `20261001000200` were applied
  to the hosted project on 2026-10-01 12:42 UTC with `supabase migration up --linked`;
  history and hashes match. The function-privilege check from `permissions.sql` and
  the help-contact column grants, RLS and view options from `protections.sql` passed
  there (run through the Supabase connector, the full `protections.sql` and
  `v1-invariants.sql` were not rerun). Both locales of `/help` on the rehearsal
  Worker list the 12 volunteers. Still open: saving the new fields in `/admin/help`
  and `/help` at 360 px.
- **Volunteer list ordering:** `20261001000300` was applied to the hosted project on
  2026-10-01 13:04 UTC together with the `551798a` Worker; history and hash match.
  Through the Supabase connector: `amp_reorder_help_contacts` is security definer
  and executable only by `authenticated`, clients hold only `SELECT` on
  `display_order`, and the 12 contacts have distinct positions. Still open: moving a
  contact in `/admin/help` on the hosted site.
- **Owners and targets:** name operators and accept RPO/RTO, backup storage and
  drill schedule. The backup runbook proposes 24 hours each, daily off-platform
  backups and a drill each semester; none of this is accepted yet.
