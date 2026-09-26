# Current validation

What has been executed, and what must still happen before launch. All runs used
local, disposable services; no hosted project or deployment has been changed.
Past runs live in git history, not here. Replace a row when you rerun it; do not
append a diary.

## Current checks

Last full runs: database chain and all nine web modes (`boundary`, `shop`,
`checkout`, `admin`, `statistics`, `scanner`, `labels`, `shelf`, `orders`)
2026-09-26. The design fixes reran the eight UI modes; database and boundary
results are from the earlier security validation on the same date.

| Check | Result |
| --- | --- |
| `bun run check`, `bun run check:scripts`, `bun run lint` | PASS, 0 errors/warnings |
| `bun test` | PASS, 217 tests |
| `python3 scripts/test-check-clipped-ink.py`, `bun run check:ink` | PASS: checker regressions and static SVG checks; dynamic shelf geometry explicitly reported for manual review |
| `bun audit` | PASS, no reported vulnerabilities |
| `./scripts/test-database.sh` | PASS: rollback/retry, ACLs/RLS, acceptance, filters, statistics, malformed input, 10 stored-data corruption cases including duplicate sale movements, concurrency, restore, schema/docs comparison, signed-JWT HTTP |
| `./scripts/test-web.sh` | PASS: real local Auth, public/staff/Worker boundaries, exact decimal transport |
| `./scripts/test-web.sh --shop` | PASS: lifecycle freshness, retained drafts, invalid saved quantities, removal focus and visible mobile drawer addresses |
| `./scripts/test-web.sh --checkout` | PASS: remote staff recovery, pre-payment recheck and navigation during that read; framing protection and Auth invitation/recovery emails in Mailpit |
| `./scripts/test-web.sh --admin` | PASS: access recovery, retained cached content and partial-inventory retry, stock field validation, audit freshness with older pages retained; drawer resizing and specification error focus |
| `./scripts/test-web.sh --statistics` | PASS: localized responsive charts, retained data and focus after a failed background read |
| `./scripts/test-web.sh --scanner` | PASS: Firefox and WebKit with synthetic camera; named long-content scrolling keeps Add/Scan visible |
| `./scripts/test-web.sh --labels` | PASS: decoded PDF QR payloads, geometry |
| `./scripts/test-web.sh --shelf` | PASS |
| `./scripts/test-web.sh --orders` | PASS: field errors and first-invalid focus, receipt freshness with selection retained, access recovery inside a pending sheet, identical uncertain-write retry and exact stock changes |
| Collaborative browser geometry | PASS: homepage in both locales/themes at 320/360/768/1280 px; specification and admin scanner dialogs at 360×320 retain reachable title, close and actions |

The dynamic `ShelfCabinetFace` viewBox was manually reviewed: its drawer shapes
are fill-only, with no clipped strokes. The static checker does not validate
dynamic geometry. Short-viewport checks do not prove physical phone keyboard behavior.

CI runs the database chain and the `boundary`, `shop`, `checkout`, `admin`,
`scanner`, `labels` and `statistics` browser modes. These results are local runs,
not CI claims.

## Migrations and schema surface

Update this section whenever a migration changes (`sha256sum supabase/migrations/*`).

- `20260917000100_ampoteket_initial.sql`: SHA-256
  `0eda5217b038887d44b1960983f7df650f6ba44458bb1f05f5f5808b5e99c69b`
- `20260924000100_archive_empty_cabinet.sql`: SHA-256
  `503d75885d3774a967f4cad7a3b891b94b4f62020a393d5620220a997be6b7d6`

24 app tables, four exact numeric domains, 26 public RPCs, 29 staff views and five
internal derived views. All views are security invoker; only `public` is exposed.
Initial data: 12 cabinets, 492 drawers and reference units; no products or stock.

A 5,002-product / 250,000-movement workload checks that catalog reads touch only
the selected products. It is a regression check, not a hosted latency guarantee.

## Still required before launch

- **Stock withdrawals/corrections:** complete real staff/non-staff browser write
  acceptance at 360 and 1280 px, including uncertain writes and a recount after
  an intervening count. Stock validation, retained drafts after read failure and
  audit freshness have passed; direct non-staff audit-page coverage remains open.
- **Phones:** camera scanning, keyboard/safe areas and the Vipps app switch on
  real devices ([checklist](docs/scanner.md)). Only the owner's iPhone has been
  used; Android and older devices are untested. System-camera handling of
  scheme-less `ampoteket.no/p/...` QR text is unverified. Homepage photographs
  have not been checked on physical phones.
- **Labels:** measure printed A4 labels on real drawers. For the P-touch printer,
  a WebUSB print from the admin editor and scanning the printed tape QR with a
  phone are unverified.
- **Hosted setup** (needs the explicit deploy decision): Supabase/Cloudflare
  configuration, Auth mail delivery (custom SMTP), the Data API cutover barrier
  and a full hosted restore drill ([deploy](docs/runbook-deploy.md),
  [backup](docs/runbook-backup-restore.md)).
- **Owners and targets:** name operators and accept RPO/RTO, backup storage and
  drill schedule. The backup runbook proposes 24 hours each, daily off-platform
  backups and a drill each semester; none of this is accepted yet.
