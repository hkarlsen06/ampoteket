"""Rollback-only corruptions prove the read-only diagnostic checks stored facts.

Run before the persistent fixtures.sql load in scripts/test-database.sh. Restore
all triggers before checking; a disabled-trigger warning must not hide a missing
semantic check. The normal fixture, retired empty storage, and historical staff
whose Auth account was deleted must pass without inventing active-state rules.
"""
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from disposable_db_guard import require_disposable_database
require_disposable_database()

ROOT = Path(__file__).resolve().parents[2]
DIAGNOSTIC = (ROOT / 'supabase/tests/v1-invariants.sql').read_text()
BODY = '\n'.join(line for line in DIAGNOSTIC.splitlines()
                 if line not in ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', 'ROLLBACK;'))
FIXTURE = (ROOT / 'supabase/tests/fixtures.sql').read_text() + """
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT public.amp_record_receipt('79000000-0000-4000-8000-000000000010',
 '[{"product_id":"73000000-0000-4000-8000-000000000001","quantity":"10"}]',NULL,'Detector receipt');
DO $$ DECLARE checkout uuid; movement bigint; revision bigint;
BEGIN
 checkout := (public.amp_prepare_checkout('79000000-0000-4000-8000-000000000011',repeat('ab',32),
   '[{"product_id":"73000000-0000-4000-8000-000000000001","quantity":"2"}]')->>'checkout_id')::uuid;
 PERFORM public.amp_recover_checkout('79000000-0000-4000-8000-000000000012',checkout,'Detector recovery');
 SELECT m.id INTO movement FROM app.inventory_movements m JOIN app.inventory_events e ON e.id=m.event_id
   WHERE e.request_id='79000000-0000-4000-8000-000000000010';
 SELECT i.revision INTO revision FROM app.inventory i WHERE product_id='73000000-0000-4000-8000-000000000001';
 PERFORM public.amp_correct_movement_and_count('79000000-0000-4000-8000-000000000013',movement,revision,-1,7,'Detector recount');
END $$;
"""
CMD = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']


def run(sql):
    return subprocess.run(CMD, input=sql, text=True, capture_output=True, timeout=15)


def passing(sql, label):
    result = run(sql)
    if result.returncode:
        raise AssertionError(f'{label}:\n{result.stderr}')


passing(DIAGNOSTIC, 'unmodified database read-only diagnostic')
passing('BEGIN;\n' + FIXTURE + '\n' + BODY + '\nROLLBACK;', 'valid recovery/recount fixture')
passing('BEGIN;\n' + FIXTURE + """
DELETE FROM auth.users WHERE id='71000000-0000-4000-8000-000000000001';
INSERT INTO app.cabinets(code,inner_rows,inner_cols,is_archived) VALUES('RETIRED-CAB',2,2,true);
INSERT INTO app.bins(code,is_archived) VALUES('RETIRED-BIN',true);
""" + BODY + '\nROLLBACK;', 'valid archived storage and retained recovery attribution after Auth deletion')

mutations = [
    ('product in retired bin', """
ALTER TABLE app.bins DISABLE TRIGGER guard_bin_archive;
UPDATE app.bins SET is_archived=true,cabinet_id=NULL,inner_row=NULL,inner_col=NULL WHERE code='TEST-BIN-1';
ALTER TABLE app.bins ENABLE TRIGGER guard_bin_archive;
""", 'product_in_archived_bin'),
    ('live bin in retired cabinet', """
ALTER TABLE app.cabinets DISABLE TRIGGER guard_cabinet_shrink;
UPDATE app.cabinets SET is_archived=true,outer_row=NULL,outer_col=NULL WHERE code='TEST-CAB-1';
ALTER TABLE app.cabinets ENABLE TRIGGER guard_cabinet_shrink;
""", 'live_bin_in_archived_cabinet'),
    ('retired bin retains coordinates', """
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.bins'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%is_archived%' LOOP
   EXECUTE format('ALTER TABLE app.bins DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE app.bins DISABLE TRIGGER guard_bin_archive;
UPDATE app.bins SET is_archived=true WHERE code='TEST-BIN-1';
ALTER TABLE app.bins ENABLE TRIGGER guard_bin_archive;
""", 'archived_bin_has_placement'),
    ('live bin loses placement', """
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.bins'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%is_archived%' LOOP
   EXECUTE format('ALTER TABLE app.bins DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE app.bins DISABLE TRIGGER bin_no_overlap;
UPDATE app.bins SET cabinet_id=NULL WHERE code='TEST-BIN-1';
ALTER TABLE app.bins ENABLE TRIGGER bin_no_overlap;
""", 'live_bin_without_placement'),
    ('recovered sale loses reason', """
ALTER TABLE app.sales DROP CONSTRAINT sales_check;
ALTER TABLE app.sales DISABLE TRIGGER immutable_rows;
UPDATE app.sales SET recovery_reason=NULL;
ALTER TABLE app.sales ENABLE TRIGGER immutable_rows;
""", 'invalid_sale_attribution'),
    ('recovery command omitted from restore', """
DELETE FROM app.command_requests WHERE id='79000000-0000-4000-8000-000000000012';
""", 'missing_recovery_command'),
    ('recount command points at missing observation', """
UPDATE app.command_requests SET result=result || '{"count_event_id":"00000000-0000-4000-8000-000000000000"}'::jsonb
 WHERE id='79000000-0000-4000-8000-000000000013';
""", 'invalid_correction_recount_result'),
    ('foreign-key data admitted with triggers off', """
SET LOCAL session_replication_role='replica';
UPDATE app.products SET category_id='00000000-0000-4000-8000-000000000000' WHERE code='TEST-R';
SET LOCAL session_replication_role='origin';
""", 'V1_BROKEN_FOREIGN_KEY'),
    ('sale no longer matches immutable snapshot', """
ALTER TABLE app.inventory_movements DISABLE TRIGGER immutable_rows;
UPDATE app.inventory_movements SET quantity_delta=-999 WHERE event_id IN (SELECT event_id FROM app.sales);
ALTER TABLE app.inventory_movements ENABLE TRIGGER immutable_rows;
""", 'sale_does_not_match_snapshot'),
]

for label, mutation, expected in mutations:
    result = run('BEGIN;\n' + FIXTURE + '\n' + mutation + '\n' + BODY + '\nROLLBACK;')
    if result.returncode == 0 or expected not in result.stderr:
        raise AssertionError(f'{label}: expected {expected}, got:\n{result.stderr}')
    if 'disabled_or_replica_only_trigger' in result.stderr:
        raise AssertionError(f'{label}: trigger was not restored before diagnostic:\n{result.stderr}')

passing(DIAGNOSTIC, 'database unchanged after rollback-only corruption probes')
print(f'PASS: {len(mutations)} stored-data corruptions detected after safeguards were re-enabled')
