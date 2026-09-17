"""Seeded workflow sequences checked against an independent Decimal stock model.

Run in a fresh database clone after fixtures.sql in scripts/test-database.sh;
this deliberately changes fixture prices/stock and must not alter other suites.
Inputs and operation order are reproducible. No additional Python packages or
hosted credentials are used. RPC failures/retries must preserve every app table;
identity sequences are deliberately excluded because PostgreSQL does not roll
back nextval(), and gaps are not lost inventory.
"""
from decimal import Decimal, ROUND_HALF_UP
import json
import os
import random
import subprocess
import uuid
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from disposable_db_guard import require_disposable_database
require_disposable_database()

SEED = 20260919
rng = random.Random(SEED)
CMD = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']
STAFF = "SELECT set_config('request.jwt.claims','{\"sub\":\"71000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}',false); SET ROLE authenticated; "
SERVICE = 'SET ROLE service_role; '
X = '73000000-0000-4000-8000-000000000001'
Y = '73000000-0000-4000-8000-000000000002'
STEP = {X: Decimal('1'), Y: Decimal('0.001')}
SALE_STEP = {X: Decimal('1'), Y: Decimal('0.1')}
PRICE = {X: Decimal('0.125'), Y: Decimal('1.255')}
model = {X: Decimal(0), Y: Decimal(0)}
history = []
receipt_requests = []
context = 'setup'


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def uid():
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def jb(value):
    return quote(json.dumps(value)) + '::jsonb'


def execute(sql, role=''):
    return subprocess.run(CMD, input=role + sql, text=True, capture_output=True, timeout=12)


def run(sql, role=''):
    result = execute(sql, role)
    if result.returncode:
        raise AssertionError(f'seed={SEED}, {context}:\n{sql}\n{result.stderr}')
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''


def obj(sql, role=''):
    return json.loads(run(sql, role), parse_float=Decimal)


def command(sql, role=STAFF):
    result = obj(sql, role)
    history.append((sql, role, result))
    return result


# Fingerprint all stored application facts, including request receipts and audit
# rows. This catches failures after an earlier item already posted a movement.
tables = obj("SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='app';")
snapshot_sql = 'SELECT jsonb_build_object(' + ','.join(
    quote(table) + ", (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) FROM app.\""
    + table.replace('"', '""') + '\" r)' for table in tables) + ');'


def fingerprint():
    return obj(snapshot_sql)


def rejected(sql, expected, role=STAFF):
    before = fingerprint()
    result = execute(sql, role)
    assert result.returncode != 0 and expected in result.stderr, (
        SEED, context, expected, result.stderr)
    assert fingerprint() == before, (SEED, context, 'failed operation changed stored facts')


def retry(saved):
    sql, role, result = saved
    before = fingerprint()
    assert obj(sql, role) == result, (SEED, context, 'retry returned different result')
    assert fingerprint() == before, (SEED, context, 'retry changed stored facts')


def revision(product):
    # Revisions are opaque inputs, not the stock oracle. All expected quantities
    # below come from generated inputs and the independent Python state machine.
    return run('SELECT revision FROM app.inventory WHERE product_id=' + quote(product) + ';')


def verify_model():
    actual = obj("SELECT jsonb_object_agg(i.product_id,jsonb_build_object('view',i.quantity::text,'ledger',"
                 "(SELECT coalesce(sum(m.quantity_delta),0)::text FROM app.inventory_movements m "
                 "WHERE m.product_id=i.product_id))) FROM app.inventory i WHERE product_id IN ("
                 + quote(X) + ',' + quote(Y) + ');')
    for product, expected in model.items():
        assert Decimal(actual[product]['view']) == expected, (SEED, context, product, expected, actual)
        assert Decimal(actual[product]['ledger']) == expected, (SEED, context, product, expected, actual)
    assert run('SELECT count(*) FROM app.command_requests WHERE result IS NULL;') == '0', (
        SEED, context, 'unfinished successful command')


def quantity(product, sale=False):
    return rng.randint(1, 29) * (SALE_STEP if sale else STEP)[product]


def receipt(items):
    request = uid()
    body = [{'product_id': p, 'quantity': str(q)} for p, q in items]
    sql = 'SELECT public.amp_record_receipt(' + quote(request) + ',' + jb(body) + ",NULL,'Property donation');"
    command(sql)
    receipt_requests.append((request, body))
    for product, amount in items:
        model[product] += amount


# Establish known physical observations rather than seeding the model from a
# database-computed balance. Existing fixture stock, if any, is reconciled to zero.
for product in (X, Y):
    run('UPDATE public.amp_products SET sale_unit_price_nok=' + quote(PRICE[product])
        + ' WHERE id=' + quote(product) + ';', STAFF)
    command('SELECT public.amp_record_single_count(' + quote(uid()) + ',' + quote(product)
            + ',' + revision(product) + ",0,'Property baseline');")
verify_model()
receipt([(X, Decimal(1)), (Y, Decimal('0.001'))])
command('SELECT public.amp_withdraw_stock(' + quote(uid()) + ','
        + jb([{'product_id': X, 'quantity': '2'}]) + ",'Property negative balance');")
model[X] -= 2
verify_model()

operations = ['receipt', 'withdrawal', 'checkout', 'count', 'stale_count',
              'invalid_receipt', 'invalid_withdrawal', 'invalid_checkout',
              'changed_retry', 'delayed_retry'] * 6
rng.shuffle(operations)
for index, operation in enumerate(operations, 1):
    context = f'case {index}/{len(operations)}: {operation}'
    product = rng.choice((X, Y))
    if operation == 'receipt':
        receipt([(p, quantity(p)) for p in rng.sample((X, Y), rng.randint(1, 2))])
        retry(history[-1])
    elif operation == 'withdrawal':
        items = [(p, quantity(p)) for p in rng.sample((X, Y), rng.randint(1, 2))]
        command('SELECT public.amp_withdraw_stock(' + quote(uid()) + ','
                + jb([{'product_id': p, 'quantity': str(q)} for p, q in items])
                + ",'Property workshop use');")
        for p, amount in items:
            model[p] -= amount
        retry(history[-1])
    elif operation == 'checkout':
        items = [(p, quantity(p, sale=True)) for p in rng.sample((X, Y), 2)]
        token = f'{rng.getrandbits(256):064x}'
        checkout = command('SELECT public.amp_prepare_checkout(' + quote(uid()) + ',' + quote(token) + ','
                           + jb([{'product_id': p, 'quantity': str(q)} for p, q in items]) + ');', SERVICE)['checkout_id']
        retry(history[-1])
        verify_model()  # Preparing a checkout must not reserve or withdraw stock.
        rejected('SELECT public.amp_confirm_checkout(' + quote(checkout) + ',' + quote('00' * 32) + ');',
                 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED', SERVICE)
        result = command('SELECT public.amp_confirm_checkout(' + quote(checkout) + ',' + quote(token) + ');', SERVICE)
        total = sum((amount * PRICE[p]).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP) for p, amount in items)
        assert Decimal(result['total_nok']) == total, (SEED, context, 'incorrect checkout rounding', result, total)
        for p, amount in items:
            model[p] -= amount
        retry(history[-1])
    elif operation == 'count':
        observed = max(model[product], Decimal(0)) if rng.choice((True, False)) else quantity(product)
        previous = model[product]
        result = command('SELECT public.amp_record_single_count(' + quote(uid()) + ',' + quote(product)
                         + ',' + revision(product) + ',' + quote(observed) + ",'Property observation');")
        assert Decimal(result['difference']) == observed - previous, (SEED, context, 'incorrect count delta')
        assert Decimal(result['quantity']) == observed, (SEED, context, 'incorrect observed quantity')
        model[product] = observed
        retry(history[-1])
    elif operation == 'stale_count':
        stale = revision(product)
        receipt([(product, quantity(product))])
        rejected('SELECT public.amp_record_single_count(' + quote(uid()) + ',' + quote(product)
                 + ',' + stale + ",0,'Stale observation');", 'STALE_STOCK_COUNT')
    elif operation == 'invalid_receipt':
        rejected('SELECT public.amp_record_receipt(' + quote(uid()) + ','
                 + jb([{'product_id': X, 'quantity': str(quantity(X))}, {'product_id': Y, 'quantity': '0.0001'}])
                 + ",NULL,'Second item is invalid');", 'INVALID_QUANTITY_STEP')
    elif operation == 'invalid_withdrawal':
        rejected('SELECT public.amp_withdraw_stock(' + quote(uid()) + ','
                 + jb([{'product_id': X, 'quantity': str(quantity(X))}, {'product_id': Y, 'quantity': None}])
                 + ",'Second item is missing quantity');", 'QUANTITY_REQUIRED')
    elif operation == 'invalid_checkout':
        rejected('SELECT public.amp_prepare_checkout(' + quote(uid()) + ',' + quote('ab' * 32) + ','
                 + jb([{'product_id': X, 'quantity': str(quantity(X))}, {'product_id': Y, 'quantity': '0.01'}])
                 + ');', 'INVALID_QUANTITY_STEP', SERVICE)
    elif operation == 'changed_retry':
        request, body = rng.choice(receipt_requests)
        rejected('SELECT public.amp_record_receipt(' + quote(request) + ',' + jb(body)
                 + ",NULL,'Changed source note');", 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT')
    else:
        retry(rng.choice(history))
    verify_model()

print(f'PASS: {len(operations)} generated workflow cases match independent Decimal model (seed {SEED})')
