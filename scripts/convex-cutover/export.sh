#!/usr/bin/env bash
# Read-only export of the hosted Supabase database for the Convex import
# (docs/runbook-cutover.md). Writes one JSON file under ~/ampoteket-exports,
# readable only by you: it holds buyer contacts and password hashes. Delete it
# once the cutover is verified.
#
# Connection (docs/runbook-cutover.md §1): either the Supabase CLI linked to the
# project (`supabase link --project-ref mqzcbdorjuefefzvuefa`), whose temporary
# login this script reads itself, or a connection string in
# AMPOTEKET_EXPORT_DATABASE_URL (Supabase dashboard → Connect → Session pooler).
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
out_dir="$HOME/ampoteket-exports/$(date -u +%Y-%m-%dT%H%M%SZ)-convex-cutover"
mkdir -p "$out_dir"
out="$out_dir/export.json"

if [[ -n "${AMPOTEKET_EXPORT_DATABASE_URL:-}" ]]; then
  connection=("$AMPOTEKET_EXPORT_DATABASE_URL")
else
  eval "$(supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
  connection=()
fi
# The role and read-only mode are set inside the session (PGOPTIONS is ignored by the pooler).
{
  echo "SET ROLE postgres;"
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
  cat scripts/convex-cutover/export.sql
  echo "COMMIT;"
} | psql -X -q -v ON_ERROR_STOP=1 -At "${connection[@]}" -o "$out" >/dev/null
# Quiet mode keeps SET/BEGIN/COMMIT out of the file; the JSON itself spans many lines.
bun -e 'JSON.parse(await Bun.file(process.argv[1]).text())' "$out" || { echo "Export is not valid JSON: $out" >&2; exit 1; }
bytes=$(wc -c < "$out")
echo "Exported $bytes bytes to $out"
