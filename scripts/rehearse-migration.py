#!/usr/bin/env python3
"""Apply pending migrations to a restored hosted checkpoint in a private local container.

Usage: python3 scripts/rehearse-migration.py CHECKPOINT.dump [--expect-changed app.t1,app.t2]

The checkpoint is a custom-format pg_dump of the hosted project
(docs/runbook-deploy.md §3). The migrations in supabase/migrations that its
history lacks are applied with the Supabase CLI. Passes when history gains
exactly those versions, earlier history rows, sequences and every table outside
--expect-changed keep their row hashes, and permissions, protections and
invariants hold. Output, including the private log, goes to
test-results/rehearsal/ (gitignored); the container is always removed.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

os.umask(0o077)
# A plain kill must still remove the container, which holds hosted Auth and contact data.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results/rehearsal'
NAME = 'ampoteket-rehearsal-' + uuid.uuid4().hex[:12]
IMAGE = 'supabase/postgres:17.6.1.136'
HISTORY = 'supabase_migrations.schema_migrations'

parser = argparse.ArgumentParser()
parser.add_argument('checkpoint', type=Path)
parser.add_argument('--expect-changed', default='', help='comma-separated tables whose rows the migration may change')
args = parser.parse_args()
expected_changes = {name for name in args.expect_changed.split(',') if name}
checkpoint = args.checkpoint.resolve()
OUT.mkdir(parents=True, exist_ok=True)
log_path = OUT / 'rehearsal.log'
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
psql = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']
summary = {'checkpoint': str(checkpoint), 'result': 'FAIL'}

with log_path.open('w') as log:
    def run(command, *, input=None, capture=False):
        result = subprocess.run(command, input=input, text=True, env=env, cwd=ROOT,
                                stdout=subprocess.PIPE if capture else log, stderr=log)
        if result.returncode:
            raise RuntimeError(f'{Path(command[0]).name} exited {result.returncode}; details in {log_path}')
        return result.stdout.strip() if capture else None

    def manifest():
        return json.loads(run(['python3', 'scripts/database-manifest.py'], capture=True))

    def history():
        return json.loads(run(psql + ['-c', f'SELECT jsonb_object_agg(version,to_jsonb(m)) FROM {HISTORY} m'], capture=True))

    try:
        # The image's own init would create Supabase schemas the dump also contains.
        run(['docker', 'run', '--rm', '-d', '--name', NAME, '-p', '127.0.0.1::5432', '--user', 'postgres',
             '--entrypoint', '/bin/bash', IMAGE, '-c',
             'initdb -D /tmp/pg -A trust --no-locale --encoding=UTF8 >/dev/null'
             ' && echo "host all all 0.0.0.0/0 trust" >>/tmp/pg/pg_hba.conf'
             ' && exec postgres -D /tmp/pg -c listen_addresses="*"'])
        port = run(['docker', 'port', NAME, '5432/tcp'], capture=True).splitlines()[0].rsplit(':', 1)[1]
        env.update(PGHOST='127.0.0.1', PGPORT=port, PGUSER='postgres', PGDATABASE='postgres', PGSSLMODE='disable')
        for _ in range(120):
            if subprocess.run(psql + ['-c', 'SELECT 1'], env=env, capture_output=True).returncode == 0:
                break
            time.sleep(0.25)
        # Every role that owns or is granted something in the dump must exist; it recreates public.
        run(psql, input='CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;'
            ' CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE supabase_admin NOLOGIN;'
            ' CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE dashboard_user NOLOGIN; DROP SCHEMA public;')
        run(['pg_restore', '--dbname', 'postgres', '--single-transaction', '--exit-on-error', str(checkpoint)])

        before, old_history = manifest(), history()
        pending = sorted(p.name.split('_', 1)[0] for p in (ROOT / 'supabase/migrations').glob('*.sql')
                         if p.name.split('_', 1)[0] not in old_history)
        assert set(old_history) <= {p.name.split('_', 1)[0] for p in (ROOT / 'supabase/migrations').glob('*.sql')}, \
            'Checkpoint history has versions missing locally'
        assert pending, 'Nothing to rehearse: the checkpoint already has every local migration'
        summary['pending'] = pending

        project = OUT / NAME
        (project / 'supabase').mkdir(parents=True)
        for entry in ('config.toml', 'migrations', 'templates'):
            source, target = ROOT / 'supabase' / entry, project / 'supabase' / entry
            shutil.copytree(source, target) if source.is_dir() else shutil.copy(source, target)
        run(['supabase', 'migration', 'up', '--workdir', str(project),
             '--db-url', f'postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable', '--yes'])
        shutil.rmtree(project)

        after, new_history = manifest(), history()
        assert set(new_history) - set(old_history) == set(pending), 'History did not gain exactly the pending versions'
        assert all(new_history[k] == v for k, v in old_history.items()), 'Earlier history rows changed'
        assert before['sequences'] == after['sequences'], 'Sequence state changed'
        changed = sorted(name for name in before['tables'].keys() | after['tables'].keys()
                         if name != HISTORY and before['tables'].get(name) != after['tables'].get(name))
        summary['changed_tables'] = changed
        assert set(changed) == expected_changes, f'Changed tables {changed}, expected {sorted(expected_changes)}'
        for check in ('permissions.sql', 'protections.sql', 'v1-invariants.sql'):
            run(psql + ['-f', f'supabase/tests/{check}'])
        assert manifest() == after, 'Post-apply checks changed stored rows'
        summary.update(result='PASS', unchanged_tables=len(before['tables']) - 1 - len(changed),
                       sequences=len(before['sequences']))
    finally:
        summary['container_removed'] = subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True).returncode == 0
        (OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary))
if not summary['container_removed']:
    sys.exit(f'Container {NAME} was not removed; run docker rm -f {NAME}')
