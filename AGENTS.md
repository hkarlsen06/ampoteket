## Project

`ampoteket.no` is the website of Ampoteket, a student-run electronics workshop
that has been running for about a year; its audience is the workshop's members, not
a public market. Besides presenting the workshop, it runs a self-service parts shelf
with stock control. Buyers need no account: browse stock, fill a cart, pay with trust-based Vipps
(self-reported, never verified), then register the purchase, which withdraws stock.
Staff (one operational role, individual Convex Auth identities) maintain products,
prices, placement, purchasing, counts and corrections, all with a full audit trail.

Documentation ownership is listed below. `docs/prosjektoversikt.md` is the
project entry point; [Current state](#current-state) below says what is live;
`VALIDATION.md` distinguishes executed evidence from open
launch checks. Brand source mapping lives in `assets/brand/README.md`.

Guiding constraint: **new students must be able to understand, operate and extend
the solution without depending on the original developer.**

## Current state

**Keep this section true.** It is the one place that says what is live right now.
When you change anything it describes (deploy, flip `SALES_OPEN`, apply a hosted
migration, add or remove an admin, configure email, enter stock, close a launch
gate), update the row and the date in the same turn and commit. If you notice it is
wrong, verify and fix it. Replace rows; history belongs in git, evidence in
`VALIDATION.md`.

Last verified: **2026-10-17** (site, sales, hosted backend, email; stock row 2026-10-14; the rest 2026-10-05), against the live site,
provider configuration and the verified import into the production Convex deployment.

| Area | State |
| --- | --- |
| Site | **Live** at `https://ampoteket.no`, Worker `ampoteket`, backed by Convex since 2026-10-17 (Supabase before). HTTP and `www` redirect to the HTTPS apex; HTTPS pages carry HSTS. **Every push to `main` on GitHub deploys production automatically** (GitHub Actions `Deploy` workflow after Validation passes; the Cloudflare Git integration is disconnected). Pushing is deploying. The workflow runs `bun run deploy:production` on Bun 1.3.14 with the GitHub `production` environment secrets `CONVEX_DEPLOY_KEY` and `CLOUDFLARE_API_TOKEN` (Cloudflare token "ampoteket GitHub Actions deploy"): it requires successful CI for the exact commit, deploys the Convex functions first, then publishes the Worker, checks the live bindings and HTTP behavior, and rolls the Worker back on failure (Convex has no rollback). Worker secrets: `CHECKOUT_SERVER_KEY` (same value as in Convex), `RESEND_API_KEY`; `SUPABASE_SECRET_KEY` is still set until the cutover is cleaned up. Current version: `bunx wrangler deployments list --env production`; executed release evidence is in `VALIDATION.md`. |
| Sales | **Closed for maintenance since 2026-10-17** for the move from Supabase to Convex ([cutover runbook](docs/runbook-cutover.md)). Sales were open from 16:24 UTC on 2026-10-06. `SALES_OPEN` is `"false"` in `wrangler.jsonc` `env.production`: `/p`, `/cart` and `/checkout` answer 503 with the "closed for maintenance" page, the checkout API answers `503 CHECKOUT_UNAVAILABLE`, and the header, footer, scanner and homepage hide their buying entry points; admin is unaffected. Reopening is the owner's decision: set `"true"` in `wrangler.jsonc` and push; a dashboard edit is overwritten by the next deploy. |
| Hosted database | Convex project `ampoteket`, production deployment `useful-bass-249` (`https://useful-bass-249.eu-west-1.convex.cloud`, EU West, Ireland) is **production with real data**. It was imported at 16:40 UTC on 2026-10-17 from a read-only export of Supabase taken with sales closed, and the import verified every table, the stock projection and every product balance against the export: 149 active products (151 in all), 5 active admins with their Supabase password hashes, 9 checkouts, 158 stock events, 558 audit rows (the audit log runs from its truncation on 2026-10-02). The same data was rehearsed on the development deployment `rosy-ostrich-835` first, where the owner signed in with an existing password and saved a count. Seven capacitors have look-alikes; `CAP-C1B5B` and `CAP-49067` still differ in nothing until a volunteer enters a specification. One product (the ST-Link programmer) is borrow-only. The Supabase project `mqzcbdorjuefefzvuefa` (Stockholm) is unchanged since the export and is the rollback copy ([runbook-cutover.md §5](docs/runbook-cutover.md#5-rollback)); it is to be paused, not deleted. Connection methods: [reaching the hosted project](docs/runbook-deploy.md#reaching-the-hosted-project). Read-only checks are fine; writes, imports and deletions only at the owner's explicit request. |
| Email | Convex Auth sends invitations and password resets through the Resend API as `Ampoteket <noreply@notify.ampoteket.no>` (`convex/lib/email.ts`); the Worker sends buyer receipts the same way. The domain is verified in Resend. Convex variables `SITE_URL` (`https://ampoteket.no`) and `RESEND_API_KEY` are set; sign-up is refused. No invitation or reset has been sent through Convex yet, no buyer receipt has been delivered, and no real message's DKIM/SPF alignment has been checked. |
| Stock and labels | Opening counts entered for 148 of 149 active products (133 with stock on hand); many are estimates rather than exact counts. No labels printed or attached. |
| Operations | Hjalmar Karlsen (`hkarlsen06`) is the primary operator for account access, backups and contact retention. An independent backup operator, accepted recovery targets, storage and schedules remain open. Main protection requires no status checks since 2026-10-04 (owner's choice, so changes can go straight to `main`); linear history is required and force pushes/deletion are blocked. Deploy still waits for Validation to pass. Vulnerability alerts, automated security fixes, secret scanning and push protection are enabled. |
| Open launch checks | Still open in `VALIDATION.md`: phones (P01–P19), labels, hosted email (no Convex invitation or reset and no buyer receipt delivered yet), independent backup operator and RPO/RTO, restore drill. |

## Read relevant guidance first

Read the relevant documents below before changing their area. They describe current
contracts; they are not a checklist for unrelated work. `convex/schema.ts` and the Convex functions win over any
doc that disagrees ([datamodell.md](docs/datamodell.md)). Historical implementations are context, not permanent requirements.
When behavior changes, update its owning contract and remove conflicting guidance
elsewhere. Keep current requirements separate from historical execution records;
link to the owner instead of copying status or implementation inventories.

A spelling or formatting edit needs only guidance relevant to that edit. Preserve
applicable content, accessibility, and data-safety requirements. Explicit user
instructions take precedence over project defaults.

| Working on | Read first |
|---|---|
| Tables, Convex functions, access checks, concurrency rules, money/quantity precision | `docs/datamodell.md` |
| SvelteKit pages and Worker endpoints | `docs/website-guide.md`, then the relevant `docs/page-*.md` |
| Exact API transport, checkout retries, scanner | `docs/api-contract.md`, `docs/checkout-recovery.md`, `docs/scanner.md`, as applicable |
| Routes, roles, scope, what is out of v1 | `docs/prosjektoversikt.md` |
| Palette, light/dark tokens, typography, logo roles, component motifs | `docs/design-system.md`, `assets/brand/README.md` |
| UI copy, languages, locale routing, links between pages | `docs/i18n.md` |
| Two-connection cases, real-API checks, acceptance matrix | `docs/concurrency-tests.md`, `VALIDATION.md` |
| Schema or function changes, seeds, disposable validation | `README.md`, `scripts/test-convex.sh` |
| The Supabase-to-Convex cutover | `docs/runbook-cutover.md` |
| Connecting to the hosted database, deploying, diagnosing production, backups, restore, opening-stock import | `docs/runbook-deploy.md`, `docs/runbook-backup-restore.md` |

## Tooling

Backend validation (also run by GitHub Actions, `.github/workflows/database.yml`):

```bash
./scripts/test-convex.sh
```

It starts its own local Convex backend with a fresh secret, deploys `convex/` to it
with type checking, runs `tests/convex/` through the native client (acceptance,
access, concurrency, import), then deletes it. It needs Bun with installed
dependencies, python3, curl, jq and the Convex backend binary in the CLI cache
(`CONVEX_AGENT_MODE=anonymous bunx convex dev --once` fetches it). No hosted
credential is involved. Development and tests stay local and disposable; point
scripts only at backends they started, never at production
([Current state](#current-state)).

Rules for backend work:

- Clients reach Convex only through the native clients and the generated typed
  `api`: `ConvexClient` via convex-svelte in the browser (`useQuery` for live
  data), `ConvexHttpClient` on the server (`src/lib/server/convex.ts`).
- Staff functions start with `requireStaff`; the three guest checkout functions
  check the Worker's `CHECKOUT_SERVER_KEY`; maintenance, import, seed and fixture
  functions are internal. A new public function is a deliberate API: add it to
  `docs/datamodell.md` §10.
- Master-data writes go through `convex/lib/audit.ts`, which records the audit
  image; ledger rows (events, movements, counts, allocations, stock levels) are
  written only by `convex/lib/inventory.ts` and the command that owns them.
- Quantities, prices and totals are exact decimal strings computed with
  `convex/lib/decimal.ts`; the backend computes totals.
- A schema change must accept every existing document, and a function change must
  keep working with the previously deployed Worker: deploys push Convex first,
  and Convex has no rollback.
- Test-only functions (`convex/fixtures.ts`, `seed:demo`, the migration reset)
  run only where `ALLOW_TEST_FIXTURES=true`, which production never sets.
- After changing `convex/`, re-run `./scripts/test-convex.sh` and update
  `VALIDATION.md`.

Pushing to `main` deploys production ([Current state](#current-state)), so push only
what the owner wants live. A manual deploy uses `bun run deploy:production`, which
requires successful CI for the exact commit, deploys the Convex functions with the
production deploy key, then publishes and verifies the Worker (vars, HTTPS and
`/contact`) and rolls the Worker back on failure; never a bare
`wrangler deploy` or `wrangler versions upload` to the `ampoteket` Worker
([runbook](docs/runbook-deploy.md#publish)). Validation takes about six minutes and
Deploy follows it; wait with `gh run watch` instead of polling.

The backend and the Worker deploy together, backend first, so a frontend change may use
a new function in the same push. The reverse needs care: a backend change runs under
the old Worker for a minute and stays if the Worker rolls back
([runbook](docs/runbook-deploy.md)).

Web frontend: SvelteKit 3 / Svelte 5 (runes) / TypeScript, Bun,
`adapter-cloudflare`, shadcn-svelte (Nova) and Tailwind CSS 4. Import primitives
from `#lib/components/ui/<component>/index.js`; use `src/app.css` tokens and `#lib/ui.js`
recipes. Read `src/lib/components/ui/README.md` before changing shared recipes;
`AdminProductEditor.svelte` is the reference form. Domain components compose
shared primitives and utilities: no local `<style>` blocks or retired global
recipes (`.btn`, `.input`, `.panel`, `.wrap`, `.section`, `.led`, etc.).
Application data, algorithms, camera video/canvas, PDF generation and SVG artwork
remain domain work. Current routes belong in `docs/prosjektoversikt.md`,
validation status in `VALIDATION.md`, component conventions in `docs/design-system.md`,
and setup/check commands in `README.md`. Dev and preview use port **5174**.

No em dashes (U+2014) anywhere in the repo, and no spaced hyphen, en dash or em
dash splitting a sentence in UI copy, components or docs; `bun run lint` fails on
them. Use a comma, colon or full stop. Unspaced en dashes stay for ranges and pairs
(`1–200`, `male–male`).

The UI is bilingual: Norwegian at `/`, English at `/en`, all copy in
`src/lib/i18n/{nb,en}.ts`, every page under `src/routes/[[locale=locale]]/`. Buyer routes
(`/p`, `/cart`, `/checkout`) sit in the `(sales)` group, whose layout answers 503
(`SALES_CLOSED`, "closed for maintenance") while `SALES_OPEN` is not `"true"`. The route table in
`docs/prosjektoversikt.md` §5 links each route to its document.
Never put user-visible text in a component and never write a bare internal
`href`; use `i18n.href(path)`. Read `docs/i18n.md` before touching routes,
links or copy. The colour scheme follows the OS; there is no theme toggle.

## Git history

Prefer rebasing over merge commits when integrating branches. Rebase the topic branch onto the
current target branch, then use a fast-forward merge so history stays linear. Do not create a
merge commit unless the user explicitly requests one or rebasing would rewrite shared history.

Commit messages use `type(scope): summary`, for example `fix(checkout): keep the cart until
registration is confirmed`. The subject names the behaviour that changed, not the activity
("refine", "fix audit findings"). Add a body only for why, when it is not obvious from the diff.

### Undo your own hunks, never the file

**Do not run `git checkout -- <file>` (or `git restore <file>`) unless you have just checked that
the file contains no changes but your own.** It discards everything uncommitted in that file, and
work that was never staged is not recoverable, not from the reflog, not from a stash.

Files may contain the user's uncommitted work. Inspect the current diff before experimenting.
Backing an experiment out means inverting **your** edits: edit them back or reverse-apply
your own hunks. Never stash or restore another person's work as incidental cleanup.

If user changes are accidentally discarded, say so immediately and suggest checking the
editor undo buffer before attempting reconstruction.

## Parallel work

Parallelize independent work with subagents where it saves time or improves quality:
independent routes, docs plus schema plus test triples. Keep messages to other
agents legible, with proper spacing between words, since a human may read them.

Several sessions often share this worktree at once:

- Stage only the paths you changed (`git add <path>`), never `git add -A` or
  `git commit -a`. Another session's half-finished work must not ride along into a
  commit, since a push deploys it.
- The dev server (5174) and local Convex backend (54329) ports are pinned. Before starting one,
  check whether it is already serving (`ss -ltnp | grep -E ':(5174|54329) '`); a
  running server may be the owner's or another session's, so do not kill it or
  assume it runs your code.
- The preview browser cannot reach `localhost`. Open `https://dev.ampoteket.no`
  (the owner's tailnet Caddy in front of 5174) instead.
- `node_modules` is shared too. If `svelte-kit sync` or a check fails right after
  a dependency change landed, run `bun install --frozen-lockfile` before debugging.

## UI rules

For UI changes, consult `docs/design-system.md` and `docs/website-guide.md` §§4–8.
Keep these boundaries in every UI change:

- No eyebrow labels above headings; headings name their own sections.
- Trust familiar controls and visual cues. Do not add copy that explains obvious
  interaction or repeats a heading, label or visible state. Keep guidance only when
  it supplies a non-obvious constraint, consequence, recovery step or accessible equivalent.
- Don't write what the UI can show. If an icon, badge, control state or the visible
  result already says it (saved, added, selected, done), use that and give screen
  readers an `sr-only` equivalent. Routine success needs no sentence.
- Mobile first: design every screen at 360 px and derive the desktop layout from it
  (one DOM, CSS-only adaptation, breakpoints 48/64rem). No horizontal page scroll at
  any width; wide data reflows into stacked rows instead of a scrolling table.
- The document is the only scroll container. The sticky header never hides or resizes,
  nothing above the fold shifts while loading, and scroll-linked motion is
  homepage-only. Scroll regions, scroll locking, programmatic scrolling and the motion
  list are owned by `docs/design-system.md` §4.1–4.2.
- Keep controls and reading positions stable through interaction; progressive disclosure grows
  below its trigger. Verify geometry at desktop and phone widths with long text.
- The app owns routine data freshness and state reconciliation; do not ask users to manage
  stale state with refresh/update buttons. Preserve input, selection and focus during
  background updates. Offer a contextual retry when a load actually fails.
- Never nest cards or confirmation boxes; confirm in the existing surface. Borders must mark
  a real grouping, independent action region, or floating surface.
- Preserve visible focus, accessible names and announcements, reduced-motion preferences,
  and WCAG 2.2 AA. State must have a non-color cue; never use opacity to convey it.
- Use semantic shadcn tokens/utilities (`bg-card`, `text-foreground`,
  `text-muted-foreground`, `text-destructive`, …), never raw hex in components.
  `--muted` is a surface; secondary text uses `--muted-foreground`. Legacy colour
  aliases remain for specialized shelf/brand CSS. Use shared Button variants and
  Field/InputGroup/Checkbox/Switch controls; status badges pair colour with labels/icons.
- Dialogs use the shared `Dialog` ([rules](src/lib/components/ui/README.md)). Inline disclosure uses `Collapsible`; preserve the header's force-mounted
  content and CSS-only desktop/phone/no-JavaScript presentation.
- Never render payment as verified ([rule](docs/website-guide.md#4-guest-checkout)). Fetch errors render as
  "Unavailable", never as "0 in stock". Scanning a QR must never register a purchase by itself.

## Testing

Run the checks appropriate to the change. Do not write new tests for reversible, low-impact
changes that mirror the implementation. Once the relevant suite passes, broaden or repeat
testing only when new changes, failures, or unresolved concerns justify it.

- Backend changes: add or update the case in `tests/convex/` and run
  `./scripts/test-convex.sh` before calling it done.
- Stock-changing behavior must hold under overlap. Cover it in
  `tests/convex/concurrency.test.ts`, which runs commands in parallel against a
  real backend; `docs/concurrency-tests.md` lists the cases.
- UI flows: the browser proofs (`./scripts/test-web.sh --<proof>`) run the built
  shop against a disposable backend. Production acceptance (§9 of
  `website-guide.md`) still needs real sign-ins; say so when it remains unverified.

## Final responses

At the end of every turn, begin the final response by explaining what the user asked for, then
explain how it was solved. Include enough context that someone returning to the project among
many parallel projects can understand what is going on from the final response alone. Keep it
brief: short paragraphs, only the detail the return-reader needs, no stock phrases or summary
headers.

Complete and verify the requested scope before stopping. An audit produces findings;
apply changes when the user requests fixes.

## Keep going without input

When a step doesn't need my input, keep going. Put status notes in the same message as your next action.
Stop and ask only when you can't continue without me, or before anything destructive: deleting data, force-pushing, or changing anything outside this repository.
