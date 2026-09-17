#!/usr/bin/env python3
"""Read-only row/sequence fingerprints for backup reconciliation; never prints data.

Use explicit libpq PGHOST/PGDATABASE/PGUSER settings or a reviewed PGSERVICE.
Freeze writers (including Auth) while taking the backup and manifest: separate
commands cannot share a snapshot, and sequence state is not transactional.
"""
import hashlib
import json
import subprocess
import sys

SQL = r"""
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL extra_float_digits = 3;
SET LOCAL row_security = off;
DO $$ BEGIN
  IF to_regclass('app.staff_members') IS NULL
     OR to_regclass('auth.users') IS NULL
     OR to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'MANIFEST_REQUIRED_SCHEMA_MISSING';
  END IF;
END $$;
SELECT format(
  'SELECT %L; SELECT %L || to_jsonb(t)::text FROM %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";',
  'table' || chr(9) || n.nspname || '.' || c.relname,
  'row' || chr(9) || n.nspname || '.' || c.relname || chr(9), n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('app','auth','supabase_migrations') AND c.relkind IN ('r','p')
ORDER BY n.nspname,c.relname
\gexec
SELECT format('SELECT %L || to_jsonb(t)::text FROM (SELECT last_value,is_called FROM %I.%I) t;',
  'sequence' || chr(9) || n.nspname || '.' || c.relname || chr(9), n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('app','auth','supabase_migrations') AND c.relkind='S'
ORDER BY n.nspname,c.relname
\gexec
ROLLBACK;
"""

process = subprocess.Popen(
    ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
)
process.stdin.write(SQL.encode())
process.stdin.close()
tables, sequences = {}, {}
for line in process.stdout:
    parts = line.rstrip(b'\n').split(b'\t', 2)
    kind, name = parts[0].decode(), parts[1].decode()
    if kind == 'table':
        tables[name] = {'rows': 0, 'hash': hashlib.sha256()}
    elif kind == 'row':
        tables[name]['rows'] += 1
        tables[name]['hash'].update(parts[2] + b'\n')
    elif kind == 'sequence':
        sequences[name] = json.loads(parts[2])
    else:
        raise SystemExit('Unexpected manifest output')
if process.wait():
    raise SystemExit('Manifest failed; no valid manifest was produced.')
for value in tables.values():
    value['sha256'] = value.pop('hash').hexdigest()
json.dump({'format': 1, 'tables': tables, 'sequences': sequences}, sys.stdout, indent=2, sort_keys=True)
print()
