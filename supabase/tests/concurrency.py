"""Overlapping SQL sessions; scripts/test-database.sh provides a disposable database."""
import json
import os
import subprocess
import time
import uuid
import sys
from pathlib import Path
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from disposable_db_guard import require_disposable_database
require_disposable_database()
CMD = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']
STAFF = 'SELECT set_config(\'request.jwt.claims\',\'{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}\',false); SET ROLE authenticated; '
SERVICE = 'SET ROLE service_role; '
X = '73000000-0000-4000-8000-000000000001'
Y = '73000000-0000-4000-8000-000000000002'
TOKEN = 'ab' * 32

def quote(s):
    return "'" + str(s).replace("'", "''") + "'"

def uid():
    return str(uuid.uuid4())

def jb(x):
    return quote(json.dumps(x)) + '::jsonb'

def run(sql, role=''):
    r = subprocess.run(CMD, input=role + sql, text=True, capture_output=True, timeout=12)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ''

def obj(sql, role=STAFF):
    return json.loads(run(sql, role))

def waitfor(sql, processes):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        for process in processes:
            if process.poll() is not None:
                raise AssertionError('Session exited before the expected lock overlap: ' + process.stderr.read())
        if run(sql) == 't':
            return
        time.sleep(0.025)
    raise AssertionError('Expected overlap not observed')

def race(sql_a, sql_b, role_a=STAFF, role_b=STAFF, error=None):
    label = 'concurrency_' + uuid.uuid4().hex
    processes = []
    try:
        a = subprocess.Popen(CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(a)
        a.stdin.write('SET application_name=' + quote(label) + "; SET statement_timeout='8s'; SET idle_in_transaction_session_timeout='20s'; " + role_a + 'BEGIN; ' + sql_a + ' SET LOCAL application_name=' + quote(label + '_held') + ';\n')
        a.stdin.flush()
        # The marker is set only after A has completed its operation. Hold its
        # transaction until B is observably waiting on a lock, then release it.
        waitfor('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=' + quote(label + '_held') + " AND state='idle in transaction');", processes)
        b = subprocess.Popen(CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(b)
        b.stdin.write('SET application_name=' + quote(label + '_b') + "; SET statement_timeout='8s'; " + role_b + sql_b + '\n')
        b.stdin.close()
        b.stdin = None
        waitfor('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=' + quote(label + '_b') + " AND wait_event_type='Lock');", processes)
        a.stdin.write('COMMIT;\n')
        a.stdin.close()
        a.stdin = None
        ao, ae = a.communicate(timeout=12)
        bo, be = b.communicate(timeout=12)
        assert a.returncode == 0, (ao, ae)
        if error:
            assert b.returncode != 0 and error in be, (bo, be)
        else:
            assert b.returncode == 0, (bo, be)
        def last_line(output):
            output = output.strip()
            return output.splitlines()[-1] if output else ''
        return (last_line(ao), last_line(bo))
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()

def prep(items):
    return obj('SELECT public.amp_prepare_checkout(' + quote(uid()) + ',' + quote(TOKEN) + ',' + jb(items) + ');', SERVICE)['checkout_id']

def confirm(c):
    return 'SELECT public.amp_confirm_checkout(' + quote(c) + ',' + quote(TOKEN) + ');'

def balance():
    return json.loads(run('SELECT jsonb_object_agg(product_id,quantity) FROM app.inventory;'), parse_float=Decimal)

def countbatch():
    return obj('SELECT public.amp_start_count_batch(' + quote(uid()) + ",'concurrency');")['batch_id']

def countcall(s, rev, n):
    return 'SELECT public.amp_record_count(' + ','.join(map(quote, [uid(), s, X, rev, n])) + ');'

def order():
    o = obj('SELECT public.amp_record_order(' + quote(uid()) + ",'test','2026-01-01T00:00:00Z'," + jb([{'product_id': X, 'quantity': '100', 'unit_cost_nok': '1'}]) + ');')['order_id']
    l = run('SELECT id FROM app.purchase_order_lines WHERE order_id=' + quote(o) + ';')
    return (o, l)
a = balance()
c = prep([{'product_id': X, 'quantity': '3'}])
aa, bb = race(confirm(c), confirm(c), SERVICE, SERVICE)
assert json.loads(aa) == json.loads(bb)
assert balance()[X] == a[X] - 3
assert run('SELECT count(*) FROM app.sales WHERE checkout_id=' + quote(c) + ';') == '1'
print('PASS: duplicate confirmation overlaps; one sale, identical response', flush=True)
a = balance()
c1 = prep([{'product_id': X, 'quantity': '2'}, {'product_id': Y, 'quantity': '0.2'}])
c2 = prep([{'product_id': Y, 'quantity': '0.3'}, {'product_id': X, 'quantity': '3'}])
race(confirm(c1), confirm(c2), SERVICE, SERVICE)
b = balance()
assert b[X] == a[X] - 5 and b[Y] == a[Y] - Decimal('0.5')
print('PASS: opposite-order carts preserve both withdrawals', flush=True)
s = countbatch()
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
c = prep([{'product_id': X, 'quantity': '1'}])
race(confirm(c), countcall(s, rev, 10), SERVICE, STAFF, 'STALE_STOCK_COUNT')
assert run('SELECT count(*) FROM app.stock_counts WHERE batch_id=' + quote(s) + ';') == '0'
print('PASS: sale then stale count rejects count with no count row', flush=True)
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
c = prep([{'product_id': X, 'quantity': '1'}])
race(countcall(s, rev, 10), confirm(c), STAFF, SERVICE)
assert balance()[X] == 9
print('PASS: count then sale subtracts from counted balance', flush=True)
o, l = order()
req = uid()
body = [{'product_id': X, 'order_line_id': l, 'quantity': '60'}]
receipt = 'SELECT public.amp_record_receipt(' + quote(req) + ',' + jb(body) + ',' + quote(o) + ');'
aa, bb = race(receipt, receipt)
assert json.loads(aa) == json.loads(bb)
assert run('SELECT outstanding_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '40'
print('PASS: concurrent receipt retry posts once', flush=True)
o, l = order()
req = uid()
receipt = 'SELECT public.amp_record_receipt(' + quote(req) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '60'}]) + ',' + quote(o) + ');'
cancel = 'SELECT public.amp_cancel_order_quantities(' + quote(uid()) + ',' + quote(o) + ',' + jb([{'order_line_id': l, 'quantity': '60'}]) + ",'test');"
race(receipt, cancel, error='INVALID_CANCELLATION_QUANTITY')
assert run('SELECT outstanding_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '40'
print('PASS: receipt racing cancellation rejects overcommit', flush=True)
s = countbatch()
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
finish = 'SELECT public.amp_finish_count_batch(' + quote(s) + ');'
race(finish, countcall(s, rev, 5), error='COUNT_BATCH_FINISHED')
print('PASS: finish racing count rejects late posting', flush=True)
o, l = order()
req = uid()
r1 = 'SELECT public.amp_record_receipt(' + quote(req) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '60'}]) + ',' + quote(o) + ');'
r2 = 'SELECT public.amp_record_receipt(' + quote(req) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '20'}]) + ',' + quote(o) + ');'
race(r1, r2, error='IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT')
print('PASS: concurrent changed payload with same key is rejected', flush=True)
o, l = order()
e = obj('SELECT public.amp_record_receipt(' + quote(uid()) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '60'}]) + ',' + quote(o) + ');')['event_id']
m = run('SELECT id FROM app.inventory_movements WHERE event_id=' + quote(e) + ';')
correction = 'SELECT public.amp_adjust_stock(' + quote(uid()) + ',' + jb([{'product_id': X, 'quantity_delta': '-50', 'corrects_movement_id': m, 'expected_revision': run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')}]) + ",'Receipt should be 10');"
cancel = 'SELECT public.amp_cancel_order_quantities(' + quote(uid()) + ',' + quote(o) + ',' + jb([{'order_line_id': l, 'quantity': '90'}]) + ",'Remainder unavailable');"
race(correction, cancel)
assert run('SELECT received_quantity=10 AND cancelled_quantity=90 AND outstanding_quantity=0 FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == 't'
print('PASS: cancellation sees concurrent receipt correction after waiting', flush=True)
s = countbatch()
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
finish = 'SELECT public.amp_finish_count_batch(' + quote(s) + ');'
race(countcall(s, rev, 5), finish)
assert balance()[X] == 5
print('PASS: count then finish posts count once', flush=True)
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
req = uid()
single = 'SELECT public.amp_record_single_count(' + quote(req) + ',' + quote(X) + ',' + rev + ",7);"
aa, bb = race(single, single)
assert json.loads(aa) == json.loads(bb)
assert balance()[X] == 7
print('PASS: concurrent single-count retry posts once', flush=True)
req = uid()
preparation = 'SELECT public.amp_prepare_checkout(' + quote(req) + ',' + quote(TOKEN) + ',' + jb([{'product_id': X, 'quantity': '1'}]) + ');'
price_edit = 'UPDATE public.amp_products SET sale_unit_price_nok=99 WHERE id=' + quote(X) + ';'
old_price = run('SELECT sale_unit_price_nok FROM app.products WHERE id=' + quote(X) + ';')
aa, bb = race(preparation, price_edit, SERVICE, STAFF)
c = json.loads(aa)['checkout_id']
assert run('SELECT unit_price_nok FROM app.checkout_lines WHERE checkout_id=' + quote(c) + ';') == old_price
print('PASS: concurrent price edit waits and cannot change prepared price', flush=True)
BIN_A = '75000000-0000-4000-8000-000000000001'
BIN_B = '75000000-0000-4000-8000-000000000002'
CAB_A = '74000000-0000-4000-8000-000000000001'
CAB_B = '74000000-0000-4000-8000-000000000002'
run('INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols) VALUES(' + quote(CAB_B) + ",'TEST-A-01-02',1,2,4,10); INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col) VALUES(" + quote(BIN_B) + ",'TEST-BIN-2'," + quote(CAB_B) + ",1,1);")

def swap(req, a, b, ca, fr, fc, frs, fcs, cb, sr, sc, srs, scs):
    return ('SELECT public.amp_swap_bins(' + ','.join(map(quote, [req, a, b, ca]))
        + ',' + ','.join(map(str, [fr, fc, frs, fcs])) + ',' + quote(cb)
        + ',' + ','.join(map(str, [sr, sc, srs, scs])) + ');')
swap_call = swap(uid(), BIN_A, BIN_B, CAB_A, 1, 1, 1, 1, CAB_B, 1, 1, 1, 1)
aa, bb = race(swap_call, swap_call)
assert json.loads(aa) == json.loads(bb)
assert run('SELECT cabinet_id FROM app.bins WHERE id=' + quote(BIN_A) + ';') == CAB_B
print('PASS: concurrent duplicate swap executes once', flush=True)
race(swap(uid(), BIN_A, BIN_B, CAB_B, 1, 1, 1, 1, CAB_A, 1, 1, 1, 1), swap(uid(), BIN_B, BIN_A, CAB_A, 1, 1, 1, 1, CAB_B, 1, 1, 1, 1), error='STALE_BIN_POSITION')
assert run('SELECT cabinet_id FROM app.bins WHERE id=' + quote(BIN_A) + ';') == CAB_A
print('PASS: opposing stale swaps serialize without moving bins twice', flush=True)
STAFF_B = STAFF.replace('71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002')
s = countbatch()
run("UPDATE app.staff_members SET is_active=false WHERE auth_user_id='71000000-0000-4000-8000-000000000001';")
close = 'SELECT public.amp_close_abandoned_count_batch(' + quote(uid()) + ',' + quote(s) + ",'Owner left');"
aa, bb = race(close, close, STAFF_B, STAFF_B)
assert json.loads(aa) == json.loads(bb)
assert run("SELECT count(*) FROM app.audit_log WHERE table_name='count_batches' AND action='UPDATE' AND row_key->>'id'=" + quote(s) + ';') == '1'
print('PASS: concurrent abandoned closure has one audit entry', flush=True)
run("UPDATE app.staff_members SET is_active=true WHERE auth_user_id='71000000-0000-4000-8000-000000000001';")
s = countbatch()
run("UPDATE app.staff_members SET is_active=false WHERE auth_user_id='71000000-0000-4000-8000-000000000001';")
reactivate = "UPDATE app.staff_members SET is_active=true WHERE auth_user_id='71000000-0000-4000-8000-000000000001';"
close = 'SELECT public.amp_close_abandoned_count_batch(' + quote(uid()) + ',' + quote(s) + ",'Owner left');"
race(reactivate, close, '', STAFF_B, 'COUNT_BATCH_OWNER_STILL_ACTIVE')
assert run('SELECT finished_at IS NULL FROM app.count_batches WHERE id=' + quote(s) + ';') == 't'
print('PASS: concurrent reactivation prevents abandoned-batch closure', flush=True)
CAB_C = '74000000-0000-4000-8000-000000000003'
run('INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols) VALUES(' + quote(CAB_C) + ",'TEST-CAB-RACE',1,3,4,10);")
insert_a = "INSERT INTO app.bins(code,cabinet_id,inner_row,inner_col) VALUES('RACE-A'," + quote(CAB_C) + ",2,2);"
insert_b = "INSERT INTO app.bins(code,cabinet_id,inner_row,inner_col) VALUES('RACE-B'," + quote(CAB_C) + ",2,2);"
race(insert_a, insert_b, STAFF, STAFF, error='BIN_POSITION_OCCUPIED')
assert run('SELECT count(*) FROM app.bins WHERE cabinet_id=' + quote(CAB_C) + ';') == '1'
print('PASS: concurrent bin inserts into one cell allow exactly one bin', flush=True)

# Different request IDs from stale forms must not double-apply one correction.
o, l = order()
e = obj('SELECT public.amp_record_receipt(' + quote(uid()) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '60'}]) + ',' + quote(o) + ');')['event_id']
m = run('SELECT id FROM app.inventory_movements WHERE event_id=' + quote(e) + ';')
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
a = balance()
body = [{'product_id': X, 'quantity_delta': '-10', 'corrects_movement_id': m, 'expected_revision': rev}]
fix_a = 'SELECT public.amp_adjust_stock(' + quote(uid()) + ',' + jb(body) + ",'Receipt should be 50');"
fix_b = 'SELECT public.amp_adjust_stock(' + quote(uid()) + ',' + jb(body) + ",'Receipt should be 50');"
race(fix_a, fix_b, STAFF, STAFF_B, 'STALE_STOCK_CORRECTION')
assert balance()[X] == a[X] - 10
assert run('SELECT received_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '50'
body[0]['expected_revision'] = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
body[0]['quantity_delta'] = '-5'
obj('SELECT public.amp_adjust_stock(' + quote(uid()) + ',' + jb(body) + ",'Fresh evidence: receipt was 45');")
assert run('SELECT received_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '45'
print('PASS: independent stale corrections serialize; one fails, refreshed correction succeeds', flush=True)

# Parent row locks cannot refresh an older snapshot. Reject unsupported isolation
# for direct placement writes as well as stock RPCs.
for statement in (
    "INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES('REPEATABLE-BIN'," + quote(CAB_C) + ",1,1);",
    'UPDATE public.amp_cabinets SET inner_rows=3 WHERE id=' + quote(CAB_C) + ';',
):
    result = subprocess.run(CMD, input=STAFF + 'BEGIN ISOLATION LEVEL REPEATABLE READ; ' + statement + 'COMMIT;', text=True, capture_output=True, timeout=12)
    assert result.returncode != 0 and 'READ_COMMITTED_REQUIRED' in result.stderr, result.stderr
print('PASS: placement insertion and cabinet shrink reject stale-snapshot isolation', flush=True)

# Volunteer recovery and the original browser must converge on one sale.
a = balance()
c = prep([{'product_id': X, 'quantity': '2'}])
recovery = 'SELECT public.amp_recover_checkout(' + quote(uid()) + ',' + quote(c) + ",'Browser credentials lost; original checkout identified');"
race(recovery, confirm(c), STAFF, SERVICE)
assert balance()[X] == a[X] - 2
assert run('SELECT count(*) FROM app.sales WHERE checkout_id=' + quote(c) + ';') == '1'
assert run('SELECT recovered_by IS NOT NULL FROM app.sales WHERE checkout_id=' + quote(c) + ';') == 't'
print('PASS: staff recovery racing original browser confirmation posts one sale', flush=True)

# A correction after an earlier count needs a fresh observation; the correction
# and new count are indivisible with respect to other stock writers.
o, l = order()
e = obj('SELECT public.amp_record_receipt(' + quote(uid()) + ',' + jb([{'product_id': X, 'order_line_id': l, 'quantity': '60'}]) + ',' + quote(o) + ');')['event_id']
m = run('SELECT id FROM app.inventory_movements WHERE event_id=' + quote(e) + ';')
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
obj('SELECT public.amp_record_single_count(' + quote(uid()) + ',' + quote(X) + ',' + rev + ",10,'First physical check');")
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
correct_count = 'SELECT public.amp_correct_movement_and_count(' + quote(uid()) + ',' + m + ',' + rev + ",-50,10,'Fresh recount while fixing receipt');"
c = prep([{'product_id': X, 'quantity': '1'}])
race(correct_count, confirm(c), STAFF, SERVICE)
assert balance()[X] == 9
assert run('SELECT received_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '10'
rev = run('SELECT revision FROM app.inventory WHERE product_id=' + quote(X) + ';')
c = prep([{'product_id': X, 'quantity': '1'}])
correct_count = 'SELECT public.amp_correct_movement_and_count(' + quote(uid()) + ',' + m + ',' + rev + ",-1,9,'Observation became stale');"
race(confirm(c), correct_count, SERVICE, STAFF, 'STALE_STOCK_COUNT')
assert balance()[X] == 8
assert run('SELECT received_quantity FROM app.purchase_line_progress WHERE id=' + quote(l) + ';') == '10'
print('PASS: correction with recount serializes with sales and rejects stale observations', flush=True)

# Bin assignment and retirement share the bin locking anchor.
bin_one, bin_two = uid(), uid()
run('INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col) VALUES(' + quote(bin_one) + ",'ARCHIVE-RACE-1'," + quote(CAB_C) + ",1,1),(" + quote(bin_two) + ",'ARCHIVE-RACE-2'," + quote(CAB_C) + ",1,2);")
assign = 'UPDATE public.amp_products SET bin_id=' + quote(bin_one) + ' WHERE id=' + quote(X) + ';'
archive = 'UPDATE public.amp_bins SET is_archived=true WHERE id=' + quote(bin_one) + ';'
race(assign, archive, error='BIN_STILL_HAS_PRODUCTS')
assign = 'UPDATE public.amp_products SET bin_id=' + quote(bin_two) + ' WHERE id=' + quote(X) + ';'
archive = 'UPDATE public.amp_bins SET is_archived=true WHERE id=' + quote(bin_two) + ';'
race(archive, assign, error='PRODUCT_BIN_UNAVAILABLE')
assert run('SELECT bin_id FROM app.products WHERE id=' + quote(X) + ';') == bin_one
print('PASS: product assignment and bin retirement cannot orphan placement', flush=True)

# A cabinet resize must serialize with a bin appearing in the removed cells,
# whichever operation acquires the cabinet anchor first.
resize_cabinet = uid()
run('INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols) VALUES(' + quote(resize_cabinet) + ",'RESIZE-RACE',2,1,4,4);")
insert_edge = "INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES('RESIZE-EDGE'," + quote(resize_cabinet) + ",4,4);"
shrink = 'UPDATE public.amp_cabinets SET inner_rows=3 WHERE id=' + quote(resize_cabinet) + ';'
race(insert_edge, shrink, error='CABINET_SHRINK_WOULD_ORPHAN_BINS')
run("UPDATE app.bins SET is_archived=true WHERE code='RESIZE-EDGE';")
insert_edge = insert_edge.replace('RESIZE-EDGE', 'RESIZE-LATE')
race(shrink, insert_edge, error='BIN_DOES_NOT_FIT_CABINET_GRID')
assert run('SELECT inner_rows FROM app.cabinets WHERE id=' + quote(resize_cabinet) + ';') == '3'
assert run("SELECT count(*) FROM app.bins WHERE code='RESIZE-LATE';") == '0'
print('PASS: bin insertion and cabinet shrink serialize in both orders', flush=True)

# Two staff editors cannot overwrite an intervening directory publication.
contact_id = uid()
run('INSERT INTO public.amp_help_contacts(id,display_name,email) VALUES(' + quote(contact_id) + ",'Concurrent volunteer','concurrent@example.invalid');", STAFF)
publish = 'UPDATE public.amp_help_contacts SET is_published=true,edit_revision=1 WHERE id=' + quote(contact_id) + ' AND edit_revision=1;'
stale_edit = 'WITH changed AS (UPDATE public.amp_help_contacts SET display_name=\'Stale name\',edit_revision=1 WHERE id=' + quote(contact_id) + ' AND edit_revision=1 RETURNING id) SELECT count(*) FROM changed;'
_, rejected_rows = race(publish, stale_edit)
assert rejected_rows == '0'
assert run('SELECT is_published AND edit_revision=2 AND display_name=\'Concurrent volunteer\' FROM app.help_contacts WHERE id=' + quote(contact_id) + ';') == 't'
print('PASS: overlapping directory edits preserve the first publication and reject the stale write', flush=True)

# Saving a drawer layout uses the same row anchors as ordinary moves and
# assignments. Every schedule observes the second connection waiting.
def layout_cabinet(cabinet_id):
    return obj('SELECT to_jsonb(c) FROM app.cabinets c WHERE id=' + quote(cabinet_id) + ';', '')

def layout_bins(cabinet_id):
    return obj("SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb) FROM app.bins b WHERE NOT is_archived AND cabinet_id=" + quote(cabinet_id) + ';', '')

def layout_call(request_id, before, cabinet, before_bins, bins):
    return 'SELECT public.amp_save_shelf_layout(' + quote(request_id) + ',' + ','.join(jb(x) for x in [before, cabinet, before_bins, bins]) + ');'

def layout_bin(cabinet_id, row, col):
    bin_id = uid()
    return dict(id=bin_id, code='LAYOUT-' + bin_id, cabinet_id=cabinet_id, inner_row=row, inner_col=col,
                row_span=1, col_span=1, label=None, is_archived=False)

layout_id = uid()
layout = dict(id=layout_id, code='LAYOUT-' + layout_id, label=None, outer_row=40, outer_col=40,
              inner_rows=2, inner_cols=2, is_archived=False)
drawers = [layout_bin(layout_id, row, col) for row in [1, 2] for col in [1, 2]]
create_layout = layout_call(uid(), None, layout, [], drawers)
aa, bb = race(create_layout, create_layout)
assert json.loads(aa) == json.loads(bb)
assert len(layout_bins(layout_id)) == 4
print('PASS: concurrent layout retries generate one cabinet and four stable drawers', flush=True)

before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
race(layout_call(uid(), before, dict(before, label='First layout'), drawers, drawers),
     layout_call(uid(), before, dict(before, label='Stale layout'), drawers, drawers), error='STALE_SHELF_LAYOUT')
assert layout_cabinet(layout_id)['label'] == 'First layout'
print('PASS: concurrent independent layout saves reject the stale complete snapshot', flush=True)

run('UPDATE app.cabinets SET inner_rows=3 WHERE id=' + quote(layout_id) + ';')
before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
insert_drawer = "INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES('LAYOUT-INSERT-RACE'," + quote(layout_id) + ",3,1);"
race(insert_drawer, layout_call(uid(), before, dict(before, label='Old topology'), drawers, drawers), error='STALE_SHELF_LAYOUT')
assert layout_cabinet(layout_id)['label'] == 'First layout'
print('PASS: layout rereads topology after waiting for a concurrent drawer insertion', flush=True)

before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
new_drawer = layout_bin(layout_id, 3, 2)
insert_drawer = "INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES('LAYOUT-LATE-INSERT'," + quote(layout_id) + ",3,2);"
race(layout_call(uid(), before, before, drawers, drawers + [new_drawer]), insert_drawer, error='BIN_POSITION_OCCUPIED')
assert len(layout_bins(layout_id)) == 6
print('PASS: a concurrent placement sees the completed layout and cannot overlap it', flush=True)

run('UPDATE app.cabinets SET inner_rows=4 WHERE id=' + quote(layout_id) + ';')
before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
moved = next(row for row in drawers if row['inner_row'] == 1 and row['inner_col'] == 1)
move = 'UPDATE public.amp_bins SET inner_row=4 WHERE id=' + quote(moved['id']) + ' AND inner_row=1;'
race(move, layout_call(uid(), before, before, drawers, drawers), error='STALE_SHELF_LAYOUT')
assert next(row for row in layout_bins(layout_id) if row['id'] == moved['id'])['inner_row'] == 4
print('PASS: a concurrent drawer move makes an old layout stale instead of moving it back', flush=True)

before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
changed = [dict(row, inner_row=1) if row['id'] == moved['id'] else row for row in drawers]
stale_move = 'WITH changed AS (UPDATE public.amp_bins SET inner_row=3 WHERE id=' + quote(moved['id']) + ' AND inner_row=4 RETURNING id) SELECT count(*) FROM changed;'
_, rows = race(layout_call(uid(), before, before, drawers, changed), stale_move)
assert rows == '0'
print('PASS: a guarded drawer move cannot overwrite a completed layout edit', flush=True)

layout_product = uid()
run('INSERT INTO app.products(id,code,name_nb,name_en,unit_code,stock_step,sale_step,sale_unit_price_nok) VALUES('
    + quote(layout_product) + ",'LAYOUT-CONCURRENT-PRODUCT','Oppsett','Layout','pcs',1,1,1);")
before = layout_cabinet(layout_id)
drawers = layout_bins(layout_id)
assign = 'UPDATE public.amp_products SET bin_id=' + quote(moved['id']) + ' WHERE id=' + quote(layout_product) + ';'
remove = layout_call(uid(), before, before, drawers, [row for row in drawers if row['id'] != moved['id']])
race(assign, remove, error='LAYOUT_HAS_PRODUCTS')
assert run('SELECT bin_id FROM app.products WHERE id=' + quote(layout_product) + ';') == moved['id']
print('PASS: layout removal waits for product assignment and keeps the occupied drawer', flush=True)

empty_drawer = next(row for row in drawers if row['id'] != moved['id'])
assign = 'UPDATE public.amp_products SET bin_id=' + quote(empty_drawer['id']) + ' WHERE id=' + quote(layout_product) + ';'
remove = layout_call(uid(), before, before, drawers, [row for row in drawers if row['id'] != empty_drawer['id']])
race(remove, assign, error='PRODUCT_BIN_UNAVAILABLE')
assert run('SELECT bin_id FROM app.products WHERE id=' + quote(layout_product) + ';') == moved['id']
assert len(layout_bins(layout_id)) == 5
print('PASS: product assignment cannot attach contents to a drawer removed by a layout save', flush=True)

# An occupied anchor may absorb an entire empty neighbour, but a simultaneous
# assignment to that neighbour must serialize with retirement in either order.
expand_id = uid()
expand_cabinet = dict(id=expand_id, code='LAYOUT-EXPAND-' + expand_id, label=None,
                     outer_row=41, outer_col=40, inner_rows=1, inner_cols=2, is_archived=False)
anchor = layout_bin(expand_id, 1, 1)
neighbour = layout_bin(expand_id, 1, 2)
obj(layout_call(uid(), None, expand_cabinet, [], [anchor, neighbour]))
anchor_product, neighbour_product = uid(), uid()
run('INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok) VALUES('
    + quote(anchor_product) + ",'EXPAND-ANCHOR-PRODUCT','Utvidelse','Expansion'," + quote(anchor['id']) + ",'pcs',1,1,1),("
    + quote(neighbour_product) + ",'EXPAND-NEIGHBOUR-PRODUCT','Nabo','Neighbour',NULL,'pcs',1,1,1);")
expand = layout_call(uid(), expand_cabinet, expand_cabinet, [anchor, neighbour], [dict(anchor, col_span=2)])
assign = 'UPDATE public.amp_products SET bin_id=' + quote(neighbour['id']) + ' WHERE id=' + quote(neighbour_product) + ';'
race(assign, expand, error='LAYOUT_HAS_PRODUCTS')
assert len(layout_bins(expand_id)) == 2
run('UPDATE app.products SET bin_id=NULL WHERE id=' + quote(neighbour_product) + ';')
race(expand, assign, error='PRODUCT_BIN_UNAVAILABLE')
assert run('SELECT bin_id FROM app.products WHERE id=' + quote(anchor_product) + ';') == anchor['id']
assert layout_bins(expand_id) == [dict(anchor, col_span=2)]
print('PASS: occupied expansion and neighbour assignment serialize in both orders without losing contents', flush=True)

# The bulk retirement checks the whole confirmed topology after waiting for
# cabinet inserts and serializes with product assignments on drawer row locks.
retire_id = uid()
retire_cabinet = dict(id=retire_id, code='RETIRE-RACE-' + retire_id, label=None,
                      outer_row=42, outer_col=40, inner_rows=1, inner_cols=4, is_archived=False)
retire_drawers = [layout_bin(retire_id, 1, col) for col in [1, 2]]
obj(layout_call(uid(), None, retire_cabinet, [], retire_drawers))

def retire_call(request_id, before, drawers):
    return 'SELECT public.amp_archive_empty_cabinet(' + quote(request_id) + ',' + jb(before) + ',' + jb(drawers) + ');'

before = layout_cabinet(retire_id)
drawers = layout_bins(retire_id)
insert = "INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES('RETIRE-RACE-INSERT'," + quote(retire_id) + ",1,3);"
race(insert, retire_call(uid(), before, drawers), error='STALE_SHELF_LAYOUT')
assert len(layout_bins(retire_id)) == 3
print('PASS: cabinet retirement rereads live drawers after a concurrent insertion', flush=True)

retire_product = uid()
run('INSERT INTO app.products(id,code,name_nb,name_en,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active) VALUES('
    + quote(retire_product) + ",'RETIRE-RACE-PRODUCT','Arkivløp','Archive race','pcs',1,1,0,false);")
before = layout_cabinet(retire_id)
drawers = layout_bins(retire_id)
assign = 'UPDATE public.amp_products SET bin_id=' + quote(drawers[0]['id']) + ' WHERE id=' + quote(retire_product) + ';'
race(assign, retire_call(uid(), before, drawers), error='BIN_STILL_HAS_PRODUCTS')
assert len(layout_bins(retire_id)) == 3
run('UPDATE app.products SET bin_id=NULL WHERE id=' + quote(retire_product) + ';')
print('PASS: an inactive product assignment blocks whole cabinet retirement', flush=True)

before = layout_cabinet(retire_id)
drawers = layout_bins(retire_id)
request_id = uid()
archive = retire_call(request_id, before, drawers)
audit_before = int(run("SELECT count(*) FROM app.audit_log WHERE action='UPDATE' AND "
                       "((table_name='cabinets' AND row_key->>'id'=" + quote(retire_id) + ") OR "
                       "(table_name='bins' AND before_data->>'cabinet_id'=" + quote(retire_id) + '));'))
first, retry = race(archive, archive)
assert json.loads(first) == json.loads(retry) == {'cabinet_id': retire_id, 'archived_bins': 3}
audit_after = int(run("SELECT count(*) FROM app.audit_log WHERE action='UPDATE' AND "
                      "((table_name='cabinets' AND row_key->>'id'=" + quote(retire_id) + ") OR "
                      "(table_name='bins' AND before_data->>'cabinet_id'=" + quote(retire_id) + '));'))
assert audit_after == audit_before + 4
assert run('SELECT is_archived FROM app.cabinets WHERE id=' + quote(retire_id) + ';') == 't'
assert len(layout_bins(retire_id)) == 0
retire_second = uid()
second_cabinet = dict(retire_cabinet, id=retire_second, code='RETIRE-RACE-' + retire_second,
                      outer_row=43)
second_drawer = layout_bin(retire_second, 1, 1)
obj(layout_call(uid(), None, second_cabinet, [], [second_drawer]))
assign = 'UPDATE public.amp_products SET bin_id=' + quote(second_drawer['id']) + ' WHERE id=' + quote(retire_product) + ';'
race(retire_call(uid(), layout_cabinet(retire_second), layout_bins(retire_second)),
     assign, error='PRODUCT_BIN_UNAVAILABLE')
assert run('SELECT bin_id IS NULL FROM app.products WHERE id=' + quote(retire_product) + ';') == 't'
print('PASS: duplicate cabinet retirement has one audit set and concurrent assignment cannot attach to archived drawers', flush=True)
