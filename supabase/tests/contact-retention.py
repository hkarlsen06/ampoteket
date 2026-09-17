"""Exercise the real bounded maintenance SQL only in test-database.sh's DB."""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from disposable_db_guard import require_disposable_database
require_disposable_database()
CMD = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']
OPERATOR = '71000000-0000-4000-8000-000000000001'
TOKEN = '56' * 32
RETENTION = CMD + ['-v', f'operator_auth_user_id={OPERATOR}', '-f', 'scripts/clear-expired-contacts.sql']


def sql(statement):
    result = subprocess.run(CMD, input=statement, text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''


def clear():
    result = subprocess.run(RETENTION, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().isdigit(), 'Routine printed something other than a count'
    return int(result.stdout.strip())


# Seed with real prepare/confirm commands; age only our synthetic snapshots.
# Trigger suppression is fixture setup, never part of the maintenance script.
cases = json.loads(sql("""
BEGIN;
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
DO $$ DECLARE j jsonb; ids uuid[]:=ARRAY[]::uuid[]; confirmed uuid; young uuid; raced uuid;
BEGIN
  FOR n IN 1..102 LOOP
    j:=public.amp_prepare_checkout(gen_random_uuid(),repeat('56',32),
      '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.1"}]','retention-private-fixture');
    ids:=array_append(ids,(j->>'checkout_id')::uuid);
  END LOOP;
  confirmed:=(public.amp_prepare_checkout(gen_random_uuid(),repeat('56',32),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.1"}]','retention-private-fixture')->>'checkout_id')::uuid;
  PERFORM public.amp_confirm_checkout(confirmed,repeat('56',32));
  young:=(public.amp_prepare_checkout(gen_random_uuid(),repeat('56',32),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.1"}]','retention-private-fixture')->>'checkout_id')::uuid;
  raced:=(public.amp_prepare_checkout(gen_random_uuid(),repeat('56',32),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.1"}]','retention-private-fixture')->>'checkout_id')::uuid;
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE app.checkouts SET created_at=clock_timestamp()-interval '2161 hours'
    WHERE id=ANY(ids) OR id=confirmed;
  UPDATE app.checkouts SET created_at=clock_timestamp()-interval '2159 hours' WHERE id=young;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM set_config('test.retention_cases',jsonb_build_object('confirmed',confirmed,'young',young,'raced',raced)::text,false);
END $$;
COMMIT;
SELECT current_setting('test.retention_cases');
"""))
before = int(sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED'"))
before_actor = int(sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED' AND actor_id='72000000-0000-4000-8000-000000000001'"))
assert [clear(), clear(), clear()] == [100, 2, 0]
assert sql("SELECT count(*) FROM app.checkout_contacts WHERE checkout_id IN ('" + cases['confirmed'] + "','" + cases['young'] + "','" + cases['raced'] + "')") == '3'
assert int(sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED'")) == before + 102
assert sql("SELECT NOT EXISTS(SELECT 1 FROM app.audit_log WHERE action='CONTACT_CLEARED' AND (before_data IS NOT NULL OR after_data IS NOT NULL))") == 't'
assert sql("SELECT NOT EXISTS(SELECT 1 FROM app.audit_log WHERE coalesce(before_data::text,'')||coalesce(after_data::text,'') LIKE '%retention-private-fixture%')") == 't'
assert sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED' AND actor_id='72000000-0000-4000-8000-000000000001'") == str(before_actor + 102)

# Missing/disabled operators fail before deleting anything.
for identity in ['71000000-0000-4000-8000-000000000099', '71000000-0000-4000-8000-000000000002']:
    if identity.endswith('002'):
        sql("UPDATE app.staff_members SET is_active=false WHERE auth_user_id='" + identity + "'")
    bad = subprocess.run(CMD + ['-v', f'operator_auth_user_id={identity}', '-f', 'scripts/clear-expired-contacts.sql'], text=True, capture_output=True, timeout=15)
    assert bad.returncode != 0 and 'STAFF_REQUIRED' in bad.stderr
sql("UPDATE app.staff_members SET is_active=true WHERE auth_user_id='71000000-0000-4000-8000-000000000002'")

# A concurrent confirmation inserts a sale without modifying the checkout row.
# Waiting on that row alone is insufficient: the subsequent fresh snapshot must
# notice the sale and preserve its contact.
sql("BEGIN; SET LOCAL session_replication_role=replica; UPDATE app.checkouts SET created_at=clock_timestamp()-interval '2161 hours' WHERE id='" + cases['raced'] + "'; COMMIT;")
label = 'retention_' + uuid.uuid4().hex
processes = []


def wait_for(query):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        for process in processes:
            if process.poll() is not None:
                raise AssertionError('Retention race process exited early: ' + process.stderr.read())
        if sql(query) == 't':
            return
        time.sleep(0.025)
    raise AssertionError('Retention lock overlap was not observed')


try:
    confirmation = subprocess.Popen(CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    processes.append(confirmation)
    confirmation.stdin.write("BEGIN; SELECT public.amp_confirm_checkout('" + cases['raced'] + "','" + TOKEN + "'); SET LOCAL application_name='" + label + "_held';\n")
    confirmation.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='" + label + "_held' AND state='idle in transaction')")
    retention = subprocess.Popen(RETENTION, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, 'PGAPPNAME': label + '_waiting'})
    processes.append(retention)
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='" + label + "_waiting' AND wait_event_type='Lock')")
    confirmation.stdin.write('COMMIT;\n')
    confirmation.stdin.close()
    confirmation.stdin = None
    _, error = confirmation.communicate(timeout=10)
    assert confirmation.returncode == 0, error
    output, error = retention.communicate(timeout=10)
    assert retention.returncode == 0 and output.strip() == '0', (output, error)
finally:
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait()
assert sql("SELECT EXISTS(SELECT 1 FROM app.checkout_contacts WHERE checkout_id='" + cases['raced'] + "')") == 't'
assert int(sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED'")) == before + 102

# Two scans starting from the same candidate set must not return a terminal zero
# merely because the first scanner removed the second scanner's first 100 rows.
sql("""
BEGIN;
DO $$ DECLARE ids uuid[]:=ARRAY[]::uuid[];
BEGIN
  FOR n IN 1..102 LOOP
    ids:=array_append(ids,(public.amp_prepare_checkout(gen_random_uuid(),repeat('56',32),
      '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.1"}]',
      'retention-private-fixture')->>'checkout_id')::uuid);
  END LOOP;
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE app.checkouts SET created_at=clock_timestamp()-interval '2161 hours' WHERE id=ANY(ids);
  PERFORM set_config('session_replication_role','origin',true);
END $$;
COMMIT;
""")
processes = []
label = 'retention_scans_' + uuid.uuid4().hex
try:
    first = subprocess.Popen(CMD + ['-v', f'operator_auth_user_id={OPERATOR}'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    processes.append(first)
    # Run the exact maintenance body, holding its transaction immediately before
    # COMMIT so the second invocation must observe the same initial candidates.
    prefix = Path('scripts/clear-expired-contacts.sql').read_text().rsplit('COMMIT;', 1)[0]
    first.stdin.write(prefix + "SET LOCAL application_name='" + label + "_held';\n")
    first.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='" + label + "_held' AND state='idle in transaction')")
    second = subprocess.Popen(RETENTION, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, 'PGAPPNAME': label + '_waiting'})
    processes.append(second)
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='" + label + "_waiting' AND wait_event_type='Lock')")
    first.stdin.write('COMMIT;\n')
    first.stdin.close()
    first.stdin = None
    _, error = first.communicate(timeout=10)
    assert first.returncode == 0, error
    output, error = second.communicate(timeout=10)
    assert second.returncode != 0 and 'CONTACT_RETENTION_RETRY_REQUIRED' in error, (output, error)
    assert output.strip() == '', 'A failed scan printed a success count'
finally:
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait()
assert [clear(), clear()] == [2, 0]
assert int(sql("SELECT count(*) FROM app.audit_log WHERE action='CONTACT_CLEARED'")) == before + 204
print('PASS: contact retention is bounded, exact-age, attributable and private; confirmation and concurrent scans cannot lose protected contacts or report false completion')
