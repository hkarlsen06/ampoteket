-- Only scripts/test-backup-restore.sh's private synthetic database.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
-- Acceptance already contains an unlinked historical staff member, correction,
-- cancellation/reversal, confirmed checkout, contact erasure and closed counts.
-- Keep a second same-name, disabled member and an unrelated recreated Auth user
-- so a restore cannot accidentally infer staff membership from a display name.
INSERT INTO auth.users(id) VALUES
  ('71000000-0000-4000-8000-000000000003'),('71000000-0000-4000-8000-000000000004');
INSERT INTO app.staff_members(id,auth_user_id,display_name,is_active) VALUES
  ('72000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000003','Test staff B',false);
UPDATE app.products SET description='Before restore: first metadata edit' WHERE code='TEST-C';
UPDATE app.products SET description='Before restore: second metadata edit' WHERE code='TEST-C';
INSERT INTO app.help_contacts(id,display_name,email,is_published) VALUES
 ('79000000-0000-4000-8000-000000000010','Published restore volunteer','restore@example.invalid',true),
 ('79000000-0000-4000-8000-000000000011','Draft restore volunteer',null,false);
UPDATE app.help_contacts SET phone='+47 12 34 56 78'
 WHERE id='79000000-0000-4000-8000-000000000010';
SELECT public.amp_start_count_batch('79000000-0000-4000-8000-000000000001','Unfinished at backup');
SELECT public.amp_prepare_checkout('79000000-0000-4000-8000-000000000002',repeat('12',32),
  '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.5"}]','synthetic retained contact');
SELECT public.amp_prepare_checkout('79000000-0000-4000-8000-000000000003',repeat('34',32),
  '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.5"}]');
SELECT public.amp_confirm_checkout(
  (SELECT id FROM app.checkouts WHERE request_id='79000000-0000-4000-8000-000000000003'),repeat('34',32));
-- Preserve a correction-of-a-correction, not just a single correction link.
DO $$ DECLARE result jsonb; movement bigint; revision bigint;
BEGIN
  result:=public.amp_record_receipt(gen_random_uuid(),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"1"}]',NULL,'Restore correction-chain fixture');
  SELECT id INTO movement FROM app.inventory_movements WHERE event_id=(result->>'event_id')::uuid;
  SELECT i.revision INTO revision FROM app.inventory i WHERE product_id='73000000-0000-4000-8000-000000000002';
  result:=public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object(
    'product_id','73000000-0000-4000-8000-000000000002','quantity_delta','-0.1',
    'corrects_movement_id',movement::text,'expected_revision',revision::text)),'Correct receipt fixture');
  SELECT id INTO movement FROM app.inventory_movements WHERE event_id=(result->>'event_id')::uuid;
  SELECT i.revision INTO revision FROM app.inventory i WHERE product_id='73000000-0000-4000-8000-000000000002';
  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object(
    'product_id','73000000-0000-4000-8000-000000000002','quantity_delta','0.1',
    'corrects_movement_id',movement::text,'expected_revision',revision::text)),'Correct the correction fixture');
END $$;
COMMIT;
