#!/usr/bin/env python3
"""Compare documented table contracts with the applied disposable database.

Forward migrations change the actual schema; historical migration text is not
the current contract. The documented DDL is compiled in a rollback-only schema
so PostgreSQL normalizes types, defaults and constraints on both sides.
"""
import json
import os
from pathlib import Path
import re
import subprocess
from disposable_db_guard import require_disposable_database

require_disposable_database()

definitions = re.findall(r'CREATE TABLE app\.\w+ \([\s\S]*?\n\);', Path('docs/datamodell.md').read_text())
if not definitions:
    raise SystemExit('No documented table contracts found.')
names = [re.search(r'CREATE TABLE app\.(\w+)', definition)[1] for definition in definitions]
documented = re.sub(r'\bapp\.(' + '|'.join(names) + r')\b', r'_amp_documented_schema.\1', '\n'.join(definitions))
query = r"""
WITH tables AS (
  SELECT c.oid, c.relname, n.nspname
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('app','_amp_documented_schema') AND c.relkind IN ('r','p')
), shapes AS (
  SELECT nspname,relname,jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_object(
      'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT coalesce(jsonb_agg(definition ORDER BY definition),'[]'::jsonb)
      FROM (SELECT replace(pg_get_constraintdef(c.oid),'_amp_documented_schema.','app.') AS definition
        FROM pg_constraint c WHERE c.conrelid=t.oid AND c.contype IN ('p','u','f','c','x')) definitions)
  ) AS shape FROM tables t
)
SELECT jsonb_object_agg(nspname,contracts) FROM (
  SELECT nspname,jsonb_object_agg(relname,shape) AS contracts FROM shapes GROUP BY nspname
) schemas;
"""
result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    input='BEGIN;\nCREATE SCHEMA _amp_documented_schema;\n' + documented + '\n' + query + '\nROLLBACK;\n',
    text=True, capture_output=True)
if result.returncode:
    raise SystemExit('Documented schema could not be checked:\n' + result.stderr)
schemas = json.loads(result.stdout)
actual, expected = schemas['app'], schemas['_amp_documented_schema']
different = sorted(name for name in actual.keys() | expected.keys() if actual.get(name) != expected.get(name))
if different:
    raise SystemExit('Applied schema differs from docs/datamodell.md: ' + ', '.join(different))
print('PASS: documented table contracts match the applied schema, including forward migrations')
