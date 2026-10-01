-- Run ONLY in the disposable restore destination, after exact manifest equality.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.restore_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'RESTORE_FAILED: %',label; END IF;
END $$;
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
DO $$ DECLARE
  old_result jsonb; retry_result jsonb; checkout_id uuid; movement_count bigint;
  before_audit bigint; before_revision bigint; before_quantity numeric; new_movement bigint;
  old_sequence bigint; old_auth uuid; forbidden_sql text;
BEGIN
  PERFORM pg_temp.restore_assert(app.current_staff_id()='72000000-0000-4000-8000-000000000002','active staff identity');
  PERFORM pg_temp.restore_assert((SELECT auth_user_id IS NULL FROM app.staff_members WHERE id='72000000-0000-4000-8000-000000000001'),'previously deleted Auth stays unlinked');
  PERFORM pg_temp.restore_assert((SELECT max(metadata_revision)>=3 FROM app.products),'metadata revisions were not reset');
  PERFORM pg_temp.restore_assert(EXISTS(SELECT 1 FROM app.movement_corrections),'historical correction fixture');
  PERFORM pg_temp.restore_assert(EXISTS(SELECT 1 FROM app.movement_corrections a
    JOIN app.movement_corrections b ON b.corrects_movement_id=a.movement_id),'correction chain fixture');
  PERFORM pg_temp.restore_assert(EXISTS(SELECT 1 FROM app.purchase_order_cancellations WHERE reverses_id IS NOT NULL),'cancellation reversal fixture');
  PERFORM pg_temp.restore_assert(EXISTS(SELECT 1 FROM app.count_batches WHERE finished_at IS NULL)
    AND EXISTS(SELECT 1 FROM app.count_batches WHERE finished_at IS NOT NULL),'open and closed batches');
  PERFORM pg_temp.restore_assert(EXISTS(SELECT 1 FROM app.checkout_contacts),'retained contact');
  PERFORM pg_temp.restore_assert((SELECT edit_revision=2 AND is_published AND phone='+47 12 34 56 78'
    FROM app.help_contacts WHERE id='79000000-0000-4000-8000-000000000010'), 'directory publication, contact and revision retained');
  PERFORM pg_temp.restore_assert((SELECT count(*)=1 FROM public.amp_help_directory() WHERE id::text LIKE '79000000-%'), 'restored directory hides drafts');
  UPDATE public.amp_help_contacts SET is_published=false,edit_revision=2
    WHERE id='79000000-0000-4000-8000-000000000010' AND edit_revision=2;
  PERFORM pg_temp.restore_assert(NOT EXISTS(SELECT FROM public.amp_help_directory() WHERE id::text LIKE '79000000-%')
    AND EXISTS(SELECT FROM app.audit_log WHERE table_name='help_contacts'
      AND actor_id='72000000-0000-4000-8000-000000000002'
      AND (after_data->>'edit_revision')::bigint=3), 'restored directory edits advance revision with audit');
  SELECT count(*) INTO movement_count FROM app.inventory_movements;
  SELECT result INTO old_result FROM app.command_requests WHERE id='79000000-0000-4000-8000-000000000002';
  retry_result:=public.amp_prepare_checkout('79000000-0000-4000-8000-000000000002',repeat('12',32),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.5"}]','synthetic retained contact');
  PERFORM pg_temp.restore_assert(old_result=retry_result,'prepare retry returns original command result');
  SELECT id INTO checkout_id FROM app.checkouts WHERE request_id='79000000-0000-4000-8000-000000000003';
  old_result:=public.amp_get_checkout(checkout_id,repeat('34',32));
  retry_result:=public.amp_confirm_checkout(checkout_id,repeat('34',32));
  PERFORM pg_temp.restore_assert(old_result=retry_result AND (SELECT count(*)=movement_count FROM app.inventory_movements),'confirm retry does not repost stock');

  -- A fresh stock operation must consume the restored sequence and append once.
  SELECT last_value INTO old_sequence FROM app.inventory_movements_id_seq;
  SELECT quantity INTO before_quantity FROM app.inventory WHERE product_id='73000000-0000-4000-8000-000000000002';
  PERFORM public.amp_record_receipt(gen_random_uuid(),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"5"}]',NULL,'Restore drill donation');
  SELECT max(id) INTO new_movement FROM app.inventory_movements;
  PERFORM pg_temp.restore_assert(new_movement>old_sequence AND
    (SELECT quantity=before_quantity+5 FROM app.inventory WHERE product_id='73000000-0000-4000-8000-000000000002'),'restored movement identity and posting');
  SELECT max(id) INTO before_audit FROM app.audit_log;
  SELECT metadata_revision INTO before_revision FROM app.products WHERE code='TEST-C';
  UPDATE app.products SET description='Restored metadata audit probe' WHERE code='TEST-C';
  PERFORM pg_temp.restore_assert((SELECT metadata_revision=before_revision+1 FROM app.products WHERE code='TEST-C')
    AND EXISTS(SELECT 1 FROM app.audit_log WHERE id>before_audit AND table_name='products'
      AND action='UPDATE' AND actor_id='72000000-0000-4000-8000-000000000002'
      AND before_data->>'description'='Before restore: second metadata edit'
      AND after_data->>'description'='Restored metadata audit probe'),'restored audit identity, actor and before/after image');

  FOREACH forbidden_sql IN ARRAY ARRAY[
    'UPDATE app.inventory_movements SET quantity_delta=quantity_delta',
    'DELETE FROM app.inventory_movements',
    'TRUNCATE app.audit_log'
  ] LOOP
    BEGIN
      EXECUTE forbidden_sql;
      RAISE EXCEPTION 'RESTORE_IMMUTABILITY_NOT_ENFORCED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'IMMUTABLE_RECORD:%' THEN RAISE; END IF;
    END;
  END LOOP;
  -- Missing parent UUID fails; ON DELETE SET NULL does not remap restore data.
  BEGIN
    UPDATE app.staff_members SET auth_user_id='71000000-0000-4000-8000-000000000099'
    WHERE id='72000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'RESTORE_MISSING_AUTH_NOT_REJECTED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  FOREACH old_auth IN ARRAY ARRAY[
    '71000000-0000-4000-8000-000000000001'::uuid,
    '71000000-0000-4000-8000-000000000003'::uuid,
    '71000000-0000-4000-8000-000000000004'::uuid
  ] LOOP
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',old_auth,'role','authenticated')::text,true);
    PERFORM pg_temp.restore_assert(app.current_staff_id() IS NULL,'deleted, disabled or recreated identity cannot become staff');
  END LOOP;
END $$;
ROLLBACK;
\echo 'PASS: restored identities, retry envelopes, sequence continuity, metadata auditing and immutability'
