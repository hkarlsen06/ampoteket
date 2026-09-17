-- Dedicated public directory, deliberately independent of Auth/staff records.
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

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO public.amp_help_contacts(id,display_name,email,is_published) VALUES
 ('76000000-0000-4000-8000-000000000001','Public volunteer','volunteer@example.invalid',true),
 ('76000000-0000-4000-8000-000000000002','Draft volunteer',null,false);
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM public.amp_help_contacts),'staff can maintain drafts and public contacts');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET is_published=true WHERE id='76000000-0000-4000-8000-000000000002'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET contact_url='javascript:alert(1)'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET contact_url='https://user:password@example.invalid/'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET contact_url='https://example.invalid:99999/'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET contact_url=E'https://example.invalid/\nmalicious'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET email='bad@example.invalid?subject=forged'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET phone='https://example.invalid'$q$,'violates check constraint');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET created_at=clock_timestamp()$q$,'permission denied');
SELECT pg_temp.expect_error($q$DELETE FROM public.amp_help_contacts$q$,'permission denied');
UPDATE public.amp_help_contacts SET phone='+47 12 34 56 78',contact_url='https://example.invalid/contact?lang=en',is_published=true,edit_revision=1
 WHERE id='76000000-0000-4000-8000-000000000002' AND edit_revision=1;
SELECT pg_temp.assert_true((SELECT edit_revision=2 FROM public.amp_help_contacts WHERE id='76000000-0000-4000-8000-000000000002'),'publication advances edit revision');
SELECT pg_temp.expect_error($q$UPDATE public.amp_help_contacts SET display_name='Stale draft',edit_revision=1 WHERE id='76000000-0000-4000-8000-000000000002'$q$,'STALE_HELP_CONTACT');
WITH changed AS (UPDATE public.amp_help_contacts SET display_name='Stale draft',edit_revision=1
 WHERE id='76000000-0000-4000-8000-000000000002' AND edit_revision=1 RETURNING *)
 SELECT pg_temp.assert_true((SELECT count(*)=0 FROM changed),'stale filtered edit changes no rows');
UPDATE public.amp_help_contacts SET is_published=false,edit_revision=2
 WHERE id='76000000-0000-4000-8000-000000000002' AND edit_revision=2;
SELECT pg_temp.assert_true((SELECT count(*)=4 FROM public.amp_audit_log WHERE table_name='help_contacts'
 AND actor_id='72000000-0000-4000-8000-000000000001' AND database_role='authenticated'),'directory changes audited with actual staff actor');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.amp_help_directory()),'anonymous read excludes drafts and unpublished contacts');
SELECT pg_temp.assert_true((SELECT array_agg(key ORDER BY key)=ARRAY['contact_url','display_name','display_order','email','id','phone'] FROM jsonb_object_keys((SELECT to_jsonb(d) FROM public.amp_help_directory() d LIMIT 1)) key),'public projection has only reviewed fields');
SELECT pg_temp.expect_error('SELECT * FROM public.amp_help_contacts','permission denied');
SELECT pg_temp.expect_error($q$INSERT INTO public.amp_help_contacts(display_name) VALUES('Forbidden')$q$,'permission denied');
SELECT pg_temp.expect_error('SELECT * FROM public.amp_help_directory(NULL,NULL,0)','INVALID_HELP_PAGE_SIZE');
SELECT pg_temp.expect_error('SELECT * FROM public.amp_help_directory(0,NULL,10)','INVALID_HELP_CURSOR');
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(NOT EXISTS(SELECT FROM public.amp_help_contacts),'ordinary login cannot read directory drafts');
SELECT pg_temp.expect_error($q$INSERT INTO public.amp_help_contacts(display_name) VALUES('Forbidden')$q$,'row-level security');
WITH changed AS (UPDATE public.amp_help_contacts SET display_name='Forbidden' RETURNING *)
 SELECT pg_temp.assert_true((SELECT count(*)=0 FROM changed),'ordinary login cannot alter directory');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.amp_help_directory()),'ordinary login retains public directory access');
RESET ROLE;
ROLLBACK;
