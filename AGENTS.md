## Project

Ampoteket is a web shop + stock system for an electronics workshop at `ampoteket.no`.
Buyers need no account: browse stock, fill a cart, pay with trust-based Vipps
(self-reported, never verified), then register the purchase, which withdraws stock.
Staff (one operational role, individual Supabase Auth identities) maintain products,
prices, placement, purchasing, counts and corrections, all with a full audit trail.

Documentation ownership is listed below. `docs/prosjektoversikt.md` is the
project entry point; `VALIDATION.md` distinguishes executed evidence from open
launch checks. Brand source mapping lives in `assets/brand/README.md`.

Guiding constraint: **new students must be able to understand, operate and extend
the solution without depending on the original developer.**

## Read relevant guidance first

Read the relevant documents below before changing their area. They describe current
contracts; they are not a checklist for unrelated work. The migration wins over any
doc that disagrees ([datamodell.md](docs/datamodell.md)). Historical implementations are context, not permanent requirements.
When behavior changes, update its owning contract and remove conflicting guidance
elsewhere. Keep current requirements separate from historical execution records;
link to the owner instead of copying status or implementation inventories.

A spelling or formatting edit needs only guidance relevant to that edit. Preserve
applicable content, accessibility, and data-safety requirements. Explicit user
instructions take precedence over project defaults.

| Working on | Read first |
|---|---|
| Tables, RPCs, RLS/grants, concurrency rules, money/quantity precision | `docs/datamodell.md` |
| SvelteKit pages and Worker endpoints | `docs/website-guide.md`, then the relevant `docs/page-*.md` |
| Exact API transport, checkout retries, scanner | `docs/api-contract.md`, `docs/checkout-recovery.md`, `docs/scanner.md`, as applicable |
| Routes, roles, scope, what is out of v1 | `docs/prosjektoversikt.md` |
| Palette, light/dark tokens, typography, logo roles, component motifs | `docs/design-system.md`, `assets/brand/README.md` |
| UI copy, languages, locale routing, links between pages | `docs/i18n.md` |
| Two-connection cases, real-API checks, acceptance matrix | `docs/concurrency-tests.md`, `VALIDATION.md` |
| Migrations, seeds, disposable validation | `README.md`, `scripts/test-database.sh` |
| Deploying to the hosted project, backups, restore, opening-stock import | `docs/runbook-deploy.md`, `docs/runbook-backup-restore.md` |

## Tooling

Database validation (also run by GitHub Actions, `.github/workflows/database.yml`):

```bash
./scripts/test-database.sh
```

Requires Linux, Docker, PostgreSQL client tools (`psql`), Python 3, curl,
Bun 1.3.14 with installed dependencies, and
**Supabase CLI 2.116.0**. The script creates its own PostgreSQL 17.6 container,
applies migrations through the CLI, runs acceptance/permission/concurrency checks,
rollback/retry, corruption and workflow sequences, full restore and isolated
PostgREST HTTP regressions, then removes its containers and temp files. No database URL or
hosted credential is needed. Never touch a hosted Supabase project; all work is
local/disposable until an explicit deploy decision.

Rules for schema work:

- Migration files must not contain top-level `BEGIN`/`COMMIT`; apply via the CLI
  so schema changes and migration history share a transaction.
- New privileged functions must explicitly revoke `PUBLIC`, `anon`,
  `authenticated` and `service_role` execution and grant only reviewed callers in
  the same migration. Update `supabase/tests/permissions.sql` when intentionally
  adding a public RPC.
- Keep `app` out of the Data API exposed-schema list. Public reads go through
  `public.amp_catalog`, `public.amp_catalog_facets`, `public.amp_shelf_map`
  and `public.amp_help_directory`; staff use their own JWT; the Worker uses the secret key
  server-side only for the three guest checkout RPCs (prepare/get/confirm) and
  Auth account creation/invitation after verifying an active staff caller.
  Membership changes use that caller's own JWT.
- No ORM, Edge Functions, realtime subscriptions, job queue, or JS-float money
  handling. Quantities/prices/totals travel as strings; the database computes totals.
- After amending the migration, re-run `./scripts/test-database.sh` and update the
  SHA-256 and counts in `VALIDATION.md`.

Deploy production only with `bun run deploy:production`, which verifies the live
vars and `/help` and rolls back on failure; never a bare `wrangler deploy` or
`wrangler versions upload` to the `ampoteket` Worker ([runbook](docs/runbook-deploy.md#publish)).

Web frontend: SvelteKit 2 / Svelte 5 (runes) / TypeScript, Bun,
`adapter-cloudflare`, shadcn-svelte (Nova) and Tailwind CSS 4. Import primitives
from `$lib/components/ui/<component>`; use `src/app.css` tokens and `$lib/ui`
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
(`1–200`, `male–male`). Only `supabase/migrations/` is exempt.

The UI is bilingual: Norwegian at `/`, English at `/en`, all copy in
`src/lib/i18n/{nb,en}.ts`, every page under `src/routes/[[locale=locale]]/`.
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

- Schema/RPC changes: `supabase/tests/acceptance.sql` and `permissions.sql` via
  `psql -X -v ON_ERROR_STOP=1 -f ...` against the disposable DB, plus the full
  `./scripts/test-database.sh` chain before calling it done.
- Stock-changing behavior must hold under overlap. Check the relevant
  two-connection case in `docs/concurrency-tests.md` (duplicate confirms,
  sale/count races, bin/cabinet-swap races, abandoned-batch closure, …).
- Production acceptance (§9 of `website-guide.md`) needs real HTTP with real
  staff/non-staff JWTs. SQL alone cannot do it; say so when it remains unverified.

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
