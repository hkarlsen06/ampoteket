-- Membership changes use real API roles; all fixture changes roll back.
\set ON_ERROR_STOP on
BEGIN;
\ir fixtures.sql
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END $$;
CREATE FUNCTION pg_temp.expect_error(statement text,message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(message in SQLERRM)=0 THEN RAISE EXCEPTION 'Wrong error: %',SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error: %',message;
END $$;
UPDATE auth.users SET email='staff-a@example.test',email_confirmed_at=clock_timestamp()
 WHERE id='71000000-0000-4000-8000-000000000001';
INSERT INTO auth.users(id,email) VALUES
 ('71300000-0000-4000-8000-000000000001','invite@example.test'),
 ('71300000-0000-4000-8000-000000000002','deleted@example.test');
INSERT INTO app.staff_members(id,auth_user_id,display_name) VALUES
 ('72300000-0000-4000-8000-000000000002','71300000-0000-4000-8000-000000000002','Deleted account');
DELETE FROM auth.users WHERE id='71300000-0000-4000-8000-000000000002';

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true((SELECT value @> '{"email":"staff-a@example.test","email_confirmed":true}'::jsonb
 FROM jsonb_array_elements(public.amp_list_staff()) WHERE value->>'id'='72000000-0000-4000-8000-000000000001'),
 'staff directory includes account email and confirmation state');
SELECT pg_temp.assert_true((SELECT value @> '{"auth_user_id":null,"email":null,"email_confirmed":false}'::jsonb
 FROM jsonb_array_elements(public.amp_list_staff()) WHERE value->>'id'='72300000-0000-4000-8000-000000000002'),
 'deleted Auth accounts retain their history and expose no stale email');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(NULL,'invite@example.test','Invite')$q$,'REQUEST_ID_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),' ','Invite')$q$,'STAFF_EMAIL_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test',' ')$q$,'STAFF_DISPLAY_NAME_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test',repeat('x',121))$q$,'STAFF_DISPLAY_NAME_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test',E'Name\n')$q$,'STAFF_DISPLAY_NAME_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'unknown@example.test','Invite')$q$,'STAFF_USER_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),NULL)$q$,'STAFF_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),gen_random_uuid())$q$,'STAFF_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'STAFF_SELF_DEACTIVATION');

SELECT public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001',' INVITE@EXAMPLE.TEST ',' New admin ') AS invited_id \gset
SELECT pg_temp.assert_true(public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','New admin')=:'invited_id'::uuid,
 'grant retry returns the same member');
SELECT pg_temp.assert_true(public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Different name')=:'invited_id'::uuid,
 'adding an active member is a no-op');
SELECT pg_temp.assert_true((SELECT display_name='New admin' AND is_active FROM public.amp_staff_members WHERE id=:'invited_id'),
 'repeat invitation never silently renames an active member');
SELECT pg_temp.assert_true((SELECT NOT (value->>'email_confirmed')::boolean FROM jsonb_array_elements(public.amp_list_staff())
 WHERE value->>'id'=:'invited_id'),'new invitations appear as unconfirmed');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','Changed')$q$,
 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','New admin','72300000-0000-4000-8000-000000000002')$q$,
 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','New admin',NULL,true)$q$,
 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','New admin')$q$,
 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT public.amp_deactivate_staff('79300000-0000-4000-8000-000000000002',:'invited_id');
SELECT pg_temp.assert_true(public.amp_deactivate_staff('79300000-0000-4000-8000-000000000002',:'invited_id')=:'invited_id'::uuid,
 'deactivation retry returns the same member');
SELECT public.amp_deactivate_staff(gen_random_uuid(),:'invited_id');
SELECT pg_temp.assert_true((SELECT NOT (value->>'is_active')::boolean FROM jsonb_array_elements(public.amp_list_staff())
 WHERE value->>'id'=:'invited_id'),'inactive members remain in the directory');
SELECT pg_temp.expect_error(format('SELECT public.amp_grant_staff_access(gen_random_uuid(),%L,%L,%L,true)',
 'invite@example.test','Stale resend',:'invited_id'),'INVITATION_SUPERSEDED');
SELECT pg_temp.assert_true(public.amp_grant_staff_access('79300000-0000-4000-8000-000000000001','invite@example.test','New admin')=:'invited_id'::uuid,
 'replaying the completed invitation returns its original member');
SELECT pg_temp.assert_true((SELECT NOT is_active FROM public.amp_staff_members WHERE id=:'invited_id'),
 'stale resend and completed grant replay cannot reactivate a revoked member');
SELECT pg_temp.assert_true(public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Returned admin',:'invited_id',false)=:'invited_id'::uuid,
 'reactivation preserves the member identity');
SELECT pg_temp.assert_true((SELECT display_name='Returned admin' AND is_active FROM public.amp_staff_members WHERE id=:'invited_id'),
 'reactivation applies the deliberately supplied name');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and(actor_id='72000000-0000-4000-8000-000000000001' AND database_role='authenticated')
 FROM public.amp_audit_log WHERE table_name='staff_members' AND row_key->>'id'=:'invited_id'),
 'grant, deactivation and reactivation each audit the acting member once');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*)=5 FROM app.command_requests WHERE command_name IN ('grant_staff_access','deactivate_staff')),
 'failed membership requests leave no retry records');

-- A stale row must not grant access to a new owner of the former email.
UPDATE auth.users SET email='changed@example.test' WHERE id='71300000-0000-4000-8000-000000000001';
INSERT INTO auth.users(id,email) VALUES
 ('71300000-0000-4000-8000-000000000003','invite@example.test'),
 ('71300000-0000-4000-8000-000000000004','deleted@example.test');
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error(format('SELECT public.amp_grant_staff_access(gen_random_uuid(),%L,%L,%L)',
 'invite@example.test','Stale row',:'invited_id'),'INVITATION_SUPERSEDED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'deleted@example.test','Stale deleted row','72300000-0000-4000-8000-000000000002')$q$,
 'INVITATION_SUPERSEDED');
RESET ROLE;
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM app.staff_members WHERE auth_user_id IN
 ('71300000-0000-4000-8000-000000000003','71300000-0000-4000-8000-000000000004')),
 'stale changed/deleted rows cannot grant a replacement Auth identity');
SELECT pg_temp.assert_true((SELECT count(*)=5 FROM app.command_requests WHERE command_name IN ('grant_staff_access','deactivate_staff')),
 'superseded invitations leave no retry records');

-- The only active member cannot deactivate themselves, including after all
-- other memberships have been disabled by privileged maintenance.
UPDATE app.staff_members SET is_active=false WHERE id<>'72000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'STAFF_SELF_DEACTIVATION');
RESET ROLE;

-- No privileged route through the service key, anonymous caller or non-staff JWT.
SET LOCAL ROLE anon;
SELECT pg_temp.expect_error('SELECT public.amp_list_staff()','permission denied');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Forbidden')$q$,'permission denied');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'permission denied');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_error('SELECT public.amp_list_staff()','permission denied');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Forbidden')$q$,'permission denied');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'permission denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
SELECT pg_temp.expect_error('SELECT public.amp_list_staff()','STAFF_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Forbidden')$q$,'STAFF_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'STAFF_REQUIRED');
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT pg_temp.expect_error('SELECT public.amp_list_staff()','STAFF_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_grant_staff_access(gen_random_uuid(),'invite@example.test','Forbidden')$q$,'STAFF_REQUIRED');
SELECT pg_temp.expect_error($q$SELECT public.amp_deactivate_staff(gen_random_uuid(),'72000000-0000-4000-8000-000000000001')$q$,'STAFF_REQUIRED');
RESET ROLE;
ROLLBACK;
