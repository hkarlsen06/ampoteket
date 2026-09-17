"""Prove protection checks reject broken safeguards, in rollback-only transactions.

scripts/test-database.sh supplies the isolated Unix-socket database. Each mutation
and checker share one transaction; both success and expected failure roll it back.
This tests the checkers themselves, not only the correct initial schema.
"""
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from disposable_db_guard import require_disposable_database
require_disposable_database()

TESTS = Path(__file__).resolve().parent
CMD = ['psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1']


def check_body(name):
    # The surrounding transaction belongs to this test, so the deliberately
    # broken safeguard is visible while the check runs and never gets committed.
    return '\n'.join(line for line in (TESTS / name).read_text().splitlines()
                     if line not in ('BEGIN;', 'ROLLBACK;'))


checks = {name: check_body(name) for name in ('protections.sql', 'permissions.sql')}


def execute(sql):
    return subprocess.run(CMD, input=sql, text=True, capture_output=True, timeout=15)


for name, body in checks.items():
    result = execute('BEGIN;\n' + body + '\nROLLBACK;')
    if result.returncode:
        raise AssertionError(f'Baseline {name} failed:\n{result.stderr}')

# Label, mutation, required actionable diagnostic. Independent mutations avoid
# one early failure hiding another missing assertion.
mutations = [
    ('disabled immutability', 'ALTER TABLE app.inventory_movements DISABLE TRIGGER immutable_rows;', 'TRIGGER_NOT_ENABLED'),
    ('disabled audit', 'ALTER TABLE app.products DISABLE TRIGGER audit_metadata;', 'TRIGGER_NOT_ENABLED'),
    ('disabled foreign keys', 'ALTER TABLE app.checkout_contacts DISABLE TRIGGER ALL;', 'TRIGGER_NOT_ENABLED'),
    ('replica session', "SET LOCAL session_replication_role='replica';", 'UNSAFE_SESSION_REPLICATION_ROLE'),
    ('wrong trigger function', 'DROP TRIGGER immutable_rows ON app.inventory_movements; CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON app.inventory_movements FOR EACH ROW EXECUTE FUNCTION app.guard_movement();', 'TRIGGER_DEFINITION_MISMATCH'),
    ('wrong trigger timing', 'DROP TRIGGER audit_metadata ON app.products; CREATE TRIGGER audit_metadata BEFORE INSERT OR UPDATE OR DELETE ON app.products FOR EACH ROW EXECUTE FUNCTION app.audit_metadata();', 'TRIGGER_DEFINITION_MISMATCH'),
    ('missing trigger event', 'DROP TRIGGER immutable_rows ON app.inventory_movements; CREATE TRIGGER immutable_rows BEFORE UPDATE ON app.inventory_movements FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();', 'TRIGGER_DEFINITION_MISMATCH'),
    ('conditional trigger bypass', 'DROP TRIGGER immutable_rows ON app.inventory_movements; CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON app.inventory_movements FOR EACH ROW WHEN (false) EXECUTE FUNCTION app.reject_mutation();', 'TRIGGER_DEFINITION_MISMATCH'),
    ('missing protective trigger', 'DROP TRIGGER immutable_truncate ON app.inventory_movements;', 'MISSING_TRIGGER'),
    ('contact owner view', 'ALTER VIEW public.amp_checkout_contacts SET (security_invoker=false);', 'VIEW_NOT_SECURITY_INVOKER'),
    ('internal owner view', 'ALTER VIEW app.inventory RESET (security_invoker);', 'VIEW_NOT_SECURITY_INVOKER'),
    ('unreviewed exposed view', 'CREATE VIEW public.amp_unreviewed AS SELECT 1;', 'UNREVIEWED_VIEW'),
    ('missing exposed view', 'DROP VIEW public.amp_checkout_contacts;', 'MISSING_VIEW'),
    ('overbroad read policy', 'ALTER POLICY staff_read ON app.checkout_contacts USING (true);', 'POLICY_DEFINITION_MISMATCH'),
    ('overbroad write policy', 'ALTER POLICY staff_update ON app.products WITH CHECK (true);', 'POLICY_DEFINITION_MISMATCH'),
    ('wrong policy command', 'DROP POLICY staff_read ON app.checkout_contacts; CREATE POLICY staff_read ON app.checkout_contacts FOR ALL TO authenticated USING ((SELECT app.is_staff()));', 'POLICY_DEFINITION_MISMATCH'),
    ('wrong policy role', 'ALTER POLICY staff_read ON app.checkout_contacts TO PUBLIC;', 'POLICY_DEFINITION_MISMATCH'),
    ('extra permissive policy', 'CREATE POLICY unreviewed ON app.checkout_contacts FOR SELECT TO authenticated USING (true);', 'UNREVIEWED_POLICY'),
    ('missing policy', 'DROP POLICY staff_read ON app.checkout_contacts;', 'MISSING_POLICY'),
    ('RLS bypass', 'ALTER TABLE app.checkout_contacts DISABLE ROW LEVEL SECURITY;', 'RLS_DISABLED'),
    ('sensitive checkout column', 'GRANT SELECT (token_digest) ON app.checkouts TO authenticated;', 'COLUMN_PRIVILEGE_MISMATCH'),
    ('forged revision column', 'GRANT UPDATE (metadata_revision) ON app.products TO authenticated;', 'COLUMN_PRIVILEGE_MISMATCH'),
    ('extra exposed writable column', 'GRANT UPDATE (metadata_revision) ON public.amp_products TO authenticated;', 'COLUMN_PRIVILEGE_MISMATCH'),
    ('unexpected truncate grant', 'GRANT TRUNCATE ON app.inventory_movements TO authenticated;', 'RELATION_PRIVILEGE_MISMATCH'),
    ('unexpected references grant', 'GRANT REFERENCES (id) ON app.products TO authenticated;', 'RELATION_PRIVILEGE_MISMATCH'),
    ('public column grant', 'GRANT SELECT (id) ON public.amp_products TO PUBLIC;', 'PUBLIC_RELATION_PRIVILEGE'),
    ('delegatable column grant', 'GRANT UPDATE (name_nb) ON app.products TO authenticated WITH GRANT OPTION;', 'UNEXPECTED_GRANT_OPTION'),
    ('API role bypass', 'ALTER ROLE authenticated BYPASSRLS;', 'UNSAFE_API_ROLE_ATTRIBUTES'),
]

for label, mutation, diagnostic in mutations:
    result = execute('BEGIN;\n' + mutation + '\n' + checks['protections.sql'] + '\nROLLBACK;')
    if result.returncode == 0 or diagnostic not in result.stderr:
        raise AssertionError(f'{label}: expected {diagnostic}, got:\n{result.stderr}')

for label, mutation, diagnostic in [
    ('unsafe search path', 'ALTER FUNCTION app.audit_metadata() SET search_path TO public;', 'UNSAFE_FUNCTION_SEARCH_PATH'),
    ('absent search path', 'ALTER FUNCTION app.audit_metadata() RESET search_path;', 'UNSAFE_FUNCTION_SEARCH_PATH'),
    ('wrong function security mode', 'ALTER FUNCTION app.audit_metadata() SECURITY INVOKER;', 'FUNCTION_SECURITY_MODE_MISMATCH'),
    ('delegatable function grant', 'GRANT EXECUTE ON FUNCTION app.is_staff() TO authenticated WITH GRANT OPTION;', 'UNEXPECTED_FUNCTION_GRANT_OPTION'),
]:
    result = execute('BEGIN;\n' + mutation + '\n' + checks['permissions.sql'] + '\nROLLBACK;')
    if result.returncode == 0 or diagnostic not in result.stderr:
        raise AssertionError(f'{label}: expected {diagnostic}, got:\n{result.stderr}')

# Confirm all rolled-back mutations left the complete protected state intact.
for name, body in checks.items():
    result = execute('BEGIN;\n' + body + '\nROLLBACK;')
    if result.returncode:
        raise AssertionError(f'After mutations {name} failed:\n{result.stderr}')

print(f'PASS: {len(mutations) + 4} rollback-only security mutations detected')
