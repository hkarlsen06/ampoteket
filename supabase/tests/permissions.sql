-- Run after every migration: new application functions are private until reviewed.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE expected_functions(signature regprocedure PRIMARY KEY,allowed_roles name[]);
INSERT INTO expected_functions VALUES
 ('app.is_staff()',ARRAY['authenticated']::name[]),
 ('public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[])',ARRAY['anon','authenticated','service_role']::name[]),
 ('public.amp_catalog_facets(text[])',ARRAY['anon','authenticated','service_role']::name[]),
 ('public.amp_help_directory(integer,uuid,integer)',ARRAY['anon','authenticated','service_role']::name[]),
 ('public.amp_shelf_map()',ARRAY['anon','authenticated','service_role']::name[]),
 ('public.amp_reorder_help_contacts(uuid[],uuid[])',ARRAY['authenticated']::name[]),
 ('public.amp_admin_statistics(uuid)',ARRAY['authenticated']::name[]),
 ('public.amp_list_staff()',ARRAY['authenticated']::name[]),
 ('public.amp_grant_staff_access(uuid,text,text,uuid,boolean)',ARRAY['authenticated']::name[]),
 ('public.amp_deactivate_staff(uuid,uuid)',ARRAY['authenticated']::name[]),
 ('public.amp_prepare_checkout(uuid,text,jsonb,text)',ARRAY['service_role']::name[]),
 ('public.amp_get_checkout(uuid,text)',ARRAY['service_role']::name[]),
 ('public.amp_confirm_checkout(uuid,text)',ARRAY['service_role']::name[]),
 ('public.amp_record_order(uuid,text,timestamptz,jsonb,numeric,text,text)',ARRAY['authenticated']::name[]),
 ('public.amp_record_receipt(uuid,jsonb,uuid,text,timestamptz)',ARRAY['authenticated']::name[]),
 ('public.amp_cancel_order_quantities(uuid,uuid,jsonb,text)',ARRAY['authenticated']::name[]),
 ('public.amp_reverse_cancellation(uuid,uuid,text)',ARRAY['authenticated']::name[]),
 ('public.amp_correct_movement_and_count(uuid,bigint,bigint,numeric,numeric,text)',ARRAY['authenticated']::name[]),
 ('public.amp_recover_checkout(uuid,uuid,text)',ARRAY['authenticated']::name[]),
 ('public.amp_adjust_stock(uuid,jsonb,text)',ARRAY['authenticated']::name[]),
 ('public.amp_withdraw_stock(uuid,jsonb,text)',ARRAY['authenticated']::name[]),
 ('public.amp_start_count_batch(uuid,text)',ARRAY['authenticated']::name[]),
 ('public.amp_record_count(uuid,uuid,uuid,bigint,numeric,text)',ARRAY['authenticated']::name[]),
 ('public.amp_record_single_count(uuid,uuid,bigint,numeric,text)',ARRAY['authenticated']::name[]),
 ('public.amp_finish_count_batch(uuid)',ARRAY['authenticated']::name[]),
 ('public.amp_clear_checkout_contact(uuid)',ARRAY['authenticated']::name[]),
 ('public.amp_save_shelf_layout(uuid,jsonb,jsonb,jsonb,jsonb)',ARRAY['authenticated']::name[]),
 ('public.amp_archive_empty_cabinet(uuid,jsonb,jsonb)',ARRAY['authenticated']::name[]),
 ('public.amp_swap_bins(uuid,uuid,uuid,uuid,integer,integer,integer,integer,uuid,integer,integer,integer,integer)',ARRAY['authenticated']::name[]),
 ('public.amp_swap_cabinets(uuid,uuid,uuid,integer,integer,integer,integer)',ARRAY['authenticated']::name[]),
 ('public.amp_close_abandoned_count_batch(uuid,uuid,text)',ARRAY['authenticated']::name[]);

DO $$ DECLARE f record; v_role name; BEGIN
  FOR f IN
    SELECT p.oid,p.proacl,p.proowner,p.prosecdef,p.proconfig,n.nspname,e.allowed_roles
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    LEFT JOIN expected_functions e ON e.signature=p.oid
    WHERE n.nspname='app' OR (n.nspname='public' AND p.proname LIKE 'amp\_%' ESCAPE '\')
  LOOP
    IF f.nspname='public' AND f.allowed_roles IS NULL THEN
      RAISE EXCEPTION 'UNREVIEWED_PUBLIC_FUNCTION: %',f.oid::regprocedure;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner)))
               WHERE grantee=0 AND privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'UNEXPECTED_FUNCTION_PRIVILEGE: PUBLIC on %',f.oid::regprocedure;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role']::name[] LOOP
      IF has_function_privilege(v_role,f.oid,'EXECUTE') IS DISTINCT FROM
         (v_role=ANY(coalesce(f.allowed_roles,ARRAY[]::name[]))) THEN
        RAISE EXCEPTION 'UNEXPECTED_FUNCTION_PRIVILEGE: % on %',v_role,f.oid::regprocedure;
      END IF;
    END LOOP;
  END LOOP;
  -- Helpers with no privileged reads/writes deliberately run as the invoker.
  -- All other application helpers and the reviewed RPC boundary are definers.
  FOR f IN SELECT p.*,n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' OR (n.nspname='public' AND p.proname LIKE 'amp\_%' ESCAPE '\')
  LOOP
    IF f.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
      RAISE EXCEPTION 'UNSAFE_FUNCTION_SEARCH_PATH: %',f.oid::regprocedure;
    END IF;
    IF f.prosecdef IS DISTINCT FROM (f.oid NOT IN (
      'app.require_read_committed()'::regprocedure,
      'app.check_items(jsonb)'::regprocedure,
      'app.reject_mutation()'::regprocedure,
      'app.guard_attribute_definition()'::regprocedure
    )) THEN
      RAISE EXCEPTION 'FUNCTION_SECURITY_MODE_MISMATCH: %',f.oid::regprocedure;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(f.proacl) a JOIN pg_roles r ON r.oid=a.grantee
               WHERE r.rolname IN ('anon','authenticated','service_role') AND a.is_grantable) THEN
      RAISE EXCEPTION 'UNEXPECTED_FUNCTION_GRANT_OPTION: %',f.oid::regprocedure;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: reviewed function privileges, security mode and fixed search_path';
END $$;
ROLLBACK;
