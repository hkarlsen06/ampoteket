-- Run ONLY against disposable local Supabase. All fixture data is rolled back.
-- psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/acceptance.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';

CREATE FUNCTION pg_temp.assert_true(p_condition boolean,p_label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF p_condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_label; END IF;
  RAISE NOTICE 'PASS: %',p_label;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text,p_message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(p_message in SQLERRM)=0 THEN
      RAISE EXCEPTION 'Wrong error; expected %, got %',p_message,SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: rejected with %',p_message;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error was not raised: %',p_message;
END $$;

\ir fixtures.sql
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

\ir shelf-layout.sql

DO $$
DECLARE
  r uuid := '73000000-0000-4000-8000-000000000001';
  c uuid := '73000000-0000-4000-8000-000000000002';
  oa uuid; ob uuid; la uuid; lb uuid; cancel_id uuid; receipt_event uuid; original_movement bigint;
  req uuid; req_count uuid; co uuid; sess uuid; j jsonb; j2 jsonb; body jsonb;
  v_before bigint; rev bigint; v_quantity numeric;
  token text := repeat('ab',32);
BEGIN
  PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM app.products WHERE bin_id='75000000-0000-4000-8000-000000000001'),'multiple products share one bin');
  PERFORM pg_temp.assert_true((SELECT quantity=0 FROM app.inventory WHERE product_id=r),'initial recorded balance is zero');
  j:=public.amp_record_order(gen_random_uuid(),'Supplier A','2026-01-01T12:00:00Z',
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','100','unit_cost_nok','1','purchase_url','https://example.invalid/a')),50);
  oa:=(j->>'order_id')::uuid;
  SELECT id INTO la FROM app.purchase_order_lines WHERE order_id=oa;
  j:=public.amp_record_order(gen_random_uuid(),'Supplier B','2026-02-01T12:00:00Z',
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','100','unit_cost_nok','1.2','purchase_url','https://example.invalid/b')));
  ob:=(j->>'order_id')::uuid;
  SELECT id INTO lb FROM app.purchase_order_lines WHERE order_id=ob;
  PERFORM pg_temp.assert_true((SELECT order_id=ob FROM app.latest_purchase WHERE product_id=r),'placed order updates latest purchase before receipt');
  PERFORM pg_temp.assert_true((SELECT quantity=0 FROM app.inventory WHERE product_id=r),'orders do not increase stock');

  req:=gen_random_uuid(); body:=jsonb_build_array(jsonb_build_object('product_id',r,'order_line_id',la,'quantity','60'));
  j:=public.amp_record_receipt(req,body,oa); receipt_event:=(j->>'event_id')::uuid;
  SELECT id INTO original_movement FROM app.inventory_movements WHERE event_id=receipt_event;
  j2:=public.amp_record_receipt(req,body,oa);
  PERFORM pg_temp.assert_true(j=j2 AND (SELECT quantity=60 FROM app.inventory WHERE product_id=r),'receipt retry creates no duplicate stock');
  PERFORM pg_temp.assert_true((SELECT outstanding_quantity=40 FROM app.purchase_line_progress WHERE id=la),'partial receipt leaves 40 outstanding');
  PERFORM pg_temp.assert_true((SELECT order_id=ob FROM app.latest_purchase WHERE product_id=r),'late receipt of older order does not replace latest purchase');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_receipt(%L,%L::jsonb,%L,%L)',req,body,oa,'changed'),'IDEMPOTENCY_KEY_REUSED');
  PERFORM pg_temp.expect_error(
    format($q$SELECT public.amp_record_order(%L,'Supplier F',clock_timestamp()+interval '2 days',%L::jsonb)$q$,
      gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1','unit_cost_nok','1'))),
    'ORDER_PLACED_IN_FUTURE');
  PERFORM pg_temp.expect_error(
    format($q$SELECT public.amp_record_order(%L,'Supplier F',NULL,%L::jsonb)$q$,
      gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1','unit_cost_nok','1'))),
    'PLACED_AT_REQUIRED');
  PERFORM pg_temp.expect_error(
    format('UPDATE app.purchase_orders SET placed_at=recorded_at+interval ''2 days'' WHERE id=%L',oa),
    'placed_at_not_in_future');
  PERFORM pg_temp.expect_error(
    format('SELECT public.amp_record_receipt(%L,%L::jsonb,%L)',gen_random_uuid(),
      jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1')),oa),
    'RECEIPT_ORDER_LINE_REQUIRED');
  PERFORM pg_temp.expect_error(
    format('SELECT public.amp_record_receipt(%L,%L::jsonb,%L)',gen_random_uuid(),
      jsonb_build_array(jsonb_build_object('product_id',r,'order_line_id',gen_random_uuid(),'quantity','1')),oa),
    'ORDER_LINE_NOT_FOUND');
  PERFORM pg_temp.expect_error(
    format('SELECT public.amp_reverse_cancellation(%L,%L,%L)',gen_random_uuid(),gen_random_uuid(),'No such cancellation'),
    'CANCELLATION_NOT_FOUND');

  PERFORM public.amp_record_receipt(gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','5')),NULL,'Donation from a student project');
  PERFORM pg_temp.assert_true((SELECT quantity=65 FROM app.inventory WHERE product_id=r),'donation increases stock');
  PERFORM pg_temp.assert_true((SELECT order_id=ob AND unit_cost_nok=1.2 FROM app.latest_purchase WHERE product_id=r),'donation does not change latest purchase');

  PERFORM public.amp_cancel_order_quantities(gen_random_uuid(),ob,
    jsonb_build_array(jsonb_build_object('order_line_id',lb,'quantity','100')),'Supplier cancelled');
  SELECT id INTO cancel_id FROM app.purchase_order_cancellations WHERE order_line_id=lb;
  PERFORM pg_temp.assert_true((SELECT order_id=oa FROM app.latest_purchase WHERE product_id=r),'fully cancelled never-received line is excluded');
  PERFORM pg_temp.assert_true((SELECT quantity=65 FROM app.inventory WHERE product_id=r),'cancellation has no stock effect');
  PERFORM public.amp_reverse_cancellation(gen_random_uuid(),cancel_id,'Cancellation was entered by mistake');
  PERFORM pg_temp.assert_true((SELECT order_id=ob FROM app.latest_purchase WHERE product_id=r),'cancellation correction restores eligibility');
  PERFORM public.amp_record_receipt(gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'order_line_id',lb,'quantity','10')),ob);
  PERFORM public.amp_cancel_order_quantities(gen_random_uuid(),ob,jsonb_build_array(jsonb_build_object('order_line_id',lb,'quantity','90')),'Remainder unavailable');
  PERFORM pg_temp.assert_true((SELECT order_id=ob FROM app.latest_purchase WHERE product_id=r),'partially received line remains latest after cancelling remainder');

  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity_delta','-50','corrects_movement_id',original_movement,'expected_revision',(SELECT revision FROM app.inventory WHERE product_id=r)::text)),'Receipt was 10, not 60');
  PERFORM pg_temp.assert_true((SELECT received_quantity=10 AND outstanding_quantity=90 FROM app.purchase_line_progress WHERE id=la),'receipt correction updates receipt progress as well as stock');
  PERFORM pg_temp.assert_true((SELECT quantity=25 FROM app.inventory WHERE product_id=r),'receipt correction changes stock by delta');
  SELECT count(*) INTO v_before FROM app.inventory_events;
  body:=jsonb_build_array(jsonb_build_object('product_id',r,'order_line_id',la,'quantity','1'),jsonb_build_object('product_id',r,'order_line_id',la,'quantity','100'));
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_receipt(%L,%L::jsonb,%L)',gen_random_uuid(),body,oa),'RECEIPT_EXCEEDS_OUTSTANDING');
  PERFORM pg_temp.assert_true((SELECT count(*)=v_before FROM app.inventory_events) AND (SELECT quantity=25 FROM app.inventory WHERE product_id=r),'multi-line failure rolls back event and earlier line');
  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity_delta','5')),'Five extra components supplied');
  PERFORM pg_temp.assert_true((SELECT received_quantity=10 FROM app.purchase_line_progress WHERE id=la),'unlinked adjustment does not invent an order receipt');

  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','31'),jsonb_build_object('product_id',c,'quantity','0.5'));
  j:=public.amp_prepare_checkout(gen_random_uuid(),token,body,'synthetic-contact-for-erasure-test'); co:=(j->>'checkout_id')::uuid;
  j:=public.amp_get_checkout(co,token);
  PERFORM pg_temp.assert_true((j->>'total_nok')::numeric=68,'checkout rounds and saves correct original prices');
  PERFORM pg_temp.assert_true((SELECT quantity=30 FROM app.inventory WHERE product_id=r),'preparing checkout does not reserve or withdraw stock');
  UPDATE app.products SET sale_unit_price_nok=3,sale_step=2,is_active=false WHERE id=r;
  j:=public.amp_confirm_checkout(co,token);
  PERFORM pg_temp.assert_true(j->>'status'='confirmed' AND (j->>'total_nok')::numeric=68,'confirmation uses old price despite deactivation and new sale step');
  PERFORM pg_temp.assert_true((SELECT quantity=-1 FROM app.inventory WHERE product_id=r) AND (SELECT quantity=-0.5 FROM app.inventory WHERE product_id=c),'negative stock and fractional measured stock are allowed');
  SELECT count(*) INTO v_before FROM app.inventory_movements;
  j2:=public.amp_confirm_checkout(co,token);
  PERFORM pg_temp.assert_true(j=j2 AND (SELECT count(*)=v_before FROM app.inventory_movements),'confirmation retry is idempotent');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_get_checkout(%L,%L)',co,repeat('cd',32)),'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED');
  PERFORM pg_temp.expect_error(format('UPDATE app.inventory_movements SET quantity_delta=1 WHERE id=%s',original_movement),'IMMUTABLE_RECORD');
  PERFORM pg_temp.expect_error(format('DELETE FROM app.checkout_lines WHERE checkout_id=%L',co),'IMMUTABLE_RECORD');
  PERFORM public.amp_clear_checkout_contact(co);
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM app.checkout_contacts WHERE checkout_id=co),'optional contact can be erased');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM app.audit_log WHERE coalesce(before_data::text,'')||coalesce(after_data::text,'') LIKE '%synthetic-contact-for-erasure-test%'),'contact value was not copied into immutable audit log');

  j:=public.amp_start_count_batch(gen_random_uuid(),'Test count'); sess:=(j->>'batch_id')::uuid;
  SELECT revision INTO rev FROM app.inventory WHERE product_id=r;
  req_count:=gen_random_uuid();
  j:=public.amp_record_count(req_count,sess,r,rev,4);
  j2:=public.amp_record_count(req_count,sess,r,rev,4);
  PERFORM pg_temp.assert_true(j=j2 AND (SELECT quantity=4 FROM app.inventory WHERE product_id=r),'count posts immediately and retry is idempotent');
  SELECT count(*) INTO v_before FROM app.inventory_movements;
  SELECT revision INTO rev FROM app.inventory WHERE product_id=r;
  PERFORM public.amp_record_count(gen_random_uuid(),sess,r,rev,4);
  PERFORM pg_temp.assert_true((SELECT count(*)=v_before FROM app.inventory_movements) AND (SELECT count(*)=2 FROM app.stock_counts WHERE batch_id=sess),'matching count is retained without a zero movement');
  PERFORM public.amp_withdraw_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1')),'Workshop use');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_count(%L,%L,%L,%s,4)',gen_random_uuid(),sess,r,rev),'STALE_STOCK_COUNT');
  PERFORM pg_temp.assert_true((SELECT quantity=3 FROM app.inventory WHERE product_id=r),'stale count does not overwrite intervening withdrawal');
  PERFORM set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  PERFORM pg_temp.expect_error(format('SELECT public.amp_finish_count_batch(%L)',sess),'COUNT_BATCH_BELONGS_TO_ANOTHER');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_count(%L,%L,%L,0,4)',gen_random_uuid(),sess,r),'COUNT_BATCH_BELONGS_TO_ANOTHER');
  PERFORM set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
  PERFORM pg_temp.expect_error(format('SELECT public.amp_finish_count_batch(%L)',gen_random_uuid()),'COUNT_BATCH_NOT_FOUND');
  PERFORM public.amp_finish_count_batch(sess);
  PERFORM public.amp_finish_count_batch(sess);
  SELECT revision INTO rev FROM app.inventory WHERE product_id=r;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_count(%L,%L,%L,%s,3)',gen_random_uuid(),sess,r,rev),'COUNT_BATCH_FINISHED');
  PERFORM pg_temp.assert_true((SELECT quantity=3 FROM app.inventory WHERE product_id=r),'finishing batch does not post stock again');
  SELECT revision INTO rev FROM app.inventory WHERE product_id=r;
  req_count:=gen_random_uuid();
  j:=public.amp_record_single_count(req_count,r,rev,7,'Ad-hoc recount at shelf');
  j2:=public.amp_record_single_count(req_count,r,rev,7,'Ad-hoc recount at shelf');
  PERFORM pg_temp.assert_true(j=j2 AND (j->>'batch_id') IS NOT NULL AND (SELECT quantity=7 FROM app.inventory WHERE product_id=r),'single count posts immediately and retry is idempotent');
  PERFORM pg_temp.assert_true((SELECT finished_at IS NOT NULL AND finished_by IS NOT NULL FROM app.count_batches WHERE id=(j->>'batch_id')::uuid),'single count batch is born finished');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_single_count(%L,%L,%s,8)',gen_random_uuid(),r,rev),'STALE_STOCK_COUNT');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_withdraw_stock(%L,%L::jsonb,NULL)',gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'))),'REASON_REQUIRED');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_adjust_stock(%L,%L::jsonb,%L)',gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity_delta','0.5')),'Invalid half resistor'),'INVALID_QUANTITY_STEP');
  PERFORM pg_temp.expect_error('SELECT 0.0000001::app.quantity','violates check constraint');
  PERFORM pg_temp.expect_error($q$UPDATE app.product_attributes SET number_value=NULL,text_value='1k' WHERE product_id='73000000-0000-4000-8000-000000000001'$q$,'ATTRIBUTE_VALUE_TYPE_MISMATCH');
END $$;

-- Stock outside the drawer wall is sellable; a note replaces coordinates.
DO $$ BEGIN
  BEGIN
    INSERT INTO app.products(id,code,name_nb,name_en,location_note,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
    VALUES ('73000000-0000-4000-8000-0000000000f1','MIS-OFF01','Filament','Filament','Filamenthylla','pcs',1,1,250,true);
    PERFORM pg_temp.assert_true((SELECT bin_code IS NULL AND cabinet_code IS NULL AND location_note='Filamenthylla'
      FROM public.amp_catalog('MIS-OFF01')),'active product without a drawer is public with its location note');
    PERFORM pg_temp.expect_error($q$UPDATE app.products SET bin_id='75000000-0000-4000-8000-000000000001' WHERE code='MIS-OFF01'$q$,'products_check');
    PERFORM pg_temp.expect_error($q$UPDATE app.products SET location_note=' ' WHERE code='MIS-OFF01'$q$,'location_note_check');
    RAISE EXCEPTION 'ROLLBACK_OFF_SHELF';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ROLLBACK_OFF_SHELF' THEN RAISE; END IF;
  END;
END $$;

-- These blocks exercise actual application roles, not just auth.uid().
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM public.amp_catalog();
  BEGIN PERFORM public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),'[]');
    RAISE EXCEPTION 'FAIL: anon executed checkout RPC';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot bypass Worker'; END;
  BEGIN PERFORM 1 FROM app.inventory_movements;
    RAISE EXCEPTION 'FAIL: anon read private ledger';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot read private ledger'; END;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.amp_products) THEN RAISE EXCEPTION 'FAIL: non-staff read staff view'; END IF;
  BEGIN PERFORM public.amp_start_count_batch(gen_random_uuid(),'Forbidden');
    RAISE EXCEPTION 'FAIL: ordinary login became staff';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: ordinary login has no staff powers'; END;
  PERFORM pg_temp.expect_error('SELECT public.amp_swap_bins(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,1,1,1,gen_random_uuid(),1,1,1,1)','STAFF_REQUIRED');
  PERFORM pg_temp.expect_error('SELECT public.amp_swap_cabinets(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,1,1,2)','STAFF_REQUIRED');
  PERFORM pg_temp.expect_error('SELECT public.amp_close_abandoned_count_batch(gen_random_uuid(),gen_random_uuid(),''test'')','STAFF_REQUIRED');
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.amp_products WHERE code='TEST-R') THEN RAISE EXCEPTION 'FAIL: staff view unreadable'; END IF;
  UPDATE public.amp_products SET sale_unit_price_nok=4 WHERE code='TEST-R';
  BEGIN UPDATE app.inventory_movements SET quantity_delta=999;
    RAISE EXCEPTION 'FAIL: staff wrote ledger directly';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: staff direct ledger write denied'; END;
  BEGIN UPDATE public.amp_staff_members SET is_active=true;
    RAISE EXCEPTION 'FAIL: staff wrote memberships directly';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: staff cannot bypass membership RPCs'; END;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM public.amp_prepare_checkout(gen_random_uuid(),repeat('ef',32),
    '[{"product_id":"73000000-0000-4000-8000-000000000002","quantity":"0.5"}]');
  BEGIN PERFORM 1 FROM app.inventory_movements;
    RAISE EXCEPTION 'FAIL: service role has direct ledger grants';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: service role has RPC access, not blanket table access'; END;
END $$;
RESET ROLE;

-- New workflow regressions run with the real authenticated role and staff JWT.
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO public.amp_cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols)
  VALUES('74000000-0000-4000-8000-000000000002','TEST-CAB-2',1,2,4,10);
INSERT INTO public.amp_bins(id,code,cabinet_id,inner_row,inner_col,row_span,col_span)
  VALUES('75000000-0000-4000-8000-000000000002','TEST-BIN-2','74000000-0000-4000-8000-000000000002',1,1,1,1);
DO $$ DECLARE
  a uuid := '75000000-0000-4000-8000-000000000001'; b uuid := '75000000-0000-4000-8000-000000000002';
  ca uuid := '74000000-0000-4000-8000-000000000001'; cb uuid := '74000000-0000-4000-8000-000000000002';
  req uuid := gen_random_uuid(); j jsonb; audit_before bigint;
BEGIN
  SELECT count(*) INTO audit_before FROM public.amp_audit_log WHERE table_name='bins' AND action='UPDATE';
  j:=public.amp_swap_bins(req,a,b,ca,1,1,1,1,cb,1,1,1,1);
  PERFORM pg_temp.assert_true(j=public.amp_swap_bins(req,a,b,ca,1,1,1,1,cb,1,1,1,1),'swap retry returns saved result without swapping back');
  PERFORM pg_temp.assert_true((SELECT cabinet_id=cb FROM public.amp_bins WHERE id=a)
    AND (SELECT cabinet_id=ca FROM public.amp_bins WHERE id=b),'occupied bins swap atomically');
  PERFORM pg_temp.assert_true((SELECT count(*)=audit_before+2 FROM public.amp_audit_log WHERE table_name='bins' AND action='UPDATE'),
    'swap audits both bins exactly once');
  PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM public.amp_products WHERE bin_id=a),'products follow the same bin after a swap');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_bins(%L,%L,%L,%L,1,1,1,1,%L,1,1,1,1)',gen_random_uuid(),a,b,ca,cb),'STALE_BIN_POSITION');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_bins(%L,%L,%L,%L,1,1,1,1,%L,1,1,1,2)',gen_random_uuid(),a,b,cb,ca),'STALE_BIN_POSITION');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_bins(%L,%L,%L,%L,1,1,1,1,%L,1,1,1,1)',req,b,a,ca,cb),'IDEMPOTENCY_KEY_REUSED');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_bins(%L,%L,%L,%L,1,1,1,1,%L,1,1,1,1)',gen_random_uuid(),a,a,cb,cb),'TWO_DISTINCT_BINS');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_bins(%L,%L,%L,%L,1,1,1,1,%L,1,1,1,1)',gen_random_uuid(),a,gen_random_uuid(),cb,cb),'BIN_NOT_FOUND');
  PERFORM pg_temp.assert_true((SELECT cabinet_id=cb FROM public.amp_bins WHERE id=a),'failed move preserves existing placement');
  -- Spanning bin covering the full top row (row 4) of the 10-wide cabinet.
  INSERT INTO public.amp_bins(id,code,cabinet_id,inner_row,inner_col,row_span,col_span)
    VALUES('75000000-0000-4000-8000-000000000003','TEST-BIN-FULL',cb,4,1,1,10);
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.amp_cabinet_free_cells WHERE cabinet_id=cb AND inner_row=4),'full-row bin leaves no free cells in its row');
  PERFORM pg_temp.expect_error(
    'INSERT INTO public.amp_bins(id,code,cabinet_id,inner_row,inner_col) VALUES(''75000000-0000-4000-8000-000000000004'',''TEST-BIN-CLASH'',''74000000-0000-4000-8000-000000000002'',4,5)',
    'BIN_POSITION_OCCUPIED');
  PERFORM pg_temp.expect_error(
    'INSERT INTO public.amp_bins(id,code,cabinet_id,inner_row,inner_col) VALUES(''75000000-0000-4000-8000-000000000005'',''TEST-BIN-OOB'',''74000000-0000-4000-8000-000000000002'',5,1)',
    'BIN_DOES_NOT_FIT');
  -- Direct UPDATE into an occupied cell fails without moving the bin.
  PERFORM pg_temp.expect_error(
    'UPDATE public.amp_bins SET cabinet_id=''74000000-0000-4000-8000-000000000002'', inner_row=4, inner_col=5 WHERE id=''75000000-0000-4000-8000-000000000002''',
    'BIN_POSITION_OCCUPIED');
  PERFORM pg_temp.assert_true((SELECT cabinet_id=ca AND inner_row=1 AND inner_col=1 FROM public.amp_bins WHERE id=b),'occupied UPDATE preserves existing placement');
  -- Direct cabinet move into an occupied outer position fails.
  PERFORM pg_temp.expect_error(
    'UPDATE public.amp_cabinets SET outer_col=2 WHERE id=''74000000-0000-4000-8000-000000000001''',
    'cabinets_position_key');
  -- Shrinking a cabinet grid below bins it holds is rejected.
  PERFORM pg_temp.expect_error(
    'UPDATE public.amp_cabinets SET inner_rows=3 WHERE id=''74000000-0000-4000-8000-000000000002''',
    'CABINET_SHRINK_WOULD_ORPHAN_BINS');
  -- Move into a genuinely empty cell with an optimistic position check.
  UPDATE public.amp_bins SET cabinet_id=ca, inner_row=2, inner_col=2
    WHERE id=b AND cabinet_id=ca AND inner_row=1 AND inner_col=1;
  PERFORM pg_temp.assert_true((SELECT cabinet_id=ca AND inner_row=2 AND inner_col=2 FROM public.amp_bins WHERE id=b),'bin moves into an empty cell');
  -- Cabinet swap, with stale-position rejection.
  j:=public.amp_swap_cabinets(gen_random_uuid(),ca,cb,1,1,1,2);
  PERFORM pg_temp.assert_true((SELECT outer_col=2 FROM public.amp_cabinets WHERE id=ca)
    AND (SELECT outer_col=1 FROM public.amp_cabinets WHERE id=cb),'occupied cabinets swap atomically');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_cabinets(%L,%L,%L,1,1,1,2)',gen_random_uuid(),ca,cb),'STALE_CABINET_POSITION');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_cabinets(%L,%L,%L,NULL,1,1,2)',gen_random_uuid(),ca,cb),'TWO_DISTINCT_CABINETS');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_swap_cabinets(%L,%L,%L,1,2,1,1)',gen_random_uuid(),ca,ca),'TWO_DISTINCT_CABINETS');
END $$;

SELECT set_config('test.abandoned_batch',public.amp_start_count_batch(gen_random_uuid(),'Leaver count')->>'batch_id',true);
SELECT set_config('test.deleted_auth_batch',public.amp_start_count_batch(gen_random_uuid(),'Deleted Auth count')->>'batch_id',true);
SELECT public.amp_record_count(gen_random_uuid(),current_setting('test.abandoned_batch')::uuid,
  '73000000-0000-4000-8000-000000000001',
  (SELECT revision FROM public.amp_inventory WHERE product_id='73000000-0000-4000-8000-000000000001'),3);
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
DO $$ BEGIN
  PERFORM pg_temp.expect_error(format('SELECT public.amp_finish_count_batch(%L)',current_setting('test.abandoned_batch')),'COUNT_BATCH_BELONGS_TO_ANOTHER');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_close_abandoned_count_batch(%L,%L,%L)',gen_random_uuid(),current_setting('test.abandoned_batch'),'Owner left'),'COUNT_BATCH_OWNER_STILL_ACTIVE');
END $$;
RESET ROLE;
UPDATE app.staff_members SET is_active=false WHERE id='72000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $$ DECLARE s uuid := current_setting('test.abandoned_batch')::uuid;
  req uuid := gen_random_uuid(); j jsonb; movement_count bigint; audit_count bigint;
BEGIN
  PERFORM pg_temp.expect_error(format('SELECT public.amp_close_abandoned_count_batch(%L,%L,%L)',gen_random_uuid(),s,' '),'CLOSURE_REASON_REQUIRED');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_close_abandoned_count_batch(%L,%L,%L)',gen_random_uuid(),gen_random_uuid(),'Owner left'),'COUNT_BATCH_NOT_FOUND');
  SELECT count(*) INTO movement_count FROM public.amp_inventory_movements;
  SELECT count(*) INTO audit_count FROM public.amp_audit_log WHERE table_name='count_batches' AND action='UPDATE';
  j:=public.amp_close_abandoned_count_batch(req,s,'Owner left the workshop');
  PERFORM pg_temp.assert_true(j=public.amp_close_abandoned_count_batch(req,s,'Owner left the workshop'),'abandoned closure retry is idempotent');
  PERFORM pg_temp.assert_true((SELECT owner_id='72000000-0000-4000-8000-000000000001'
    AND finished_by='72000000-0000-4000-8000-000000000002' AND finished_at IS NOT NULL
    AND finish_reason='Owner left the workshop' FROM public.amp_count_batches WHERE id=s),'closure preserves owner and records closer and reason');
  PERFORM pg_temp.assert_true((SELECT count(*)=audit_count+1 FROM public.amp_audit_log WHERE table_name='count_batches' AND action='UPDATE')
    AND EXISTS (SELECT 1 FROM public.amp_audit_log WHERE table_name='count_batches' AND row_key->>'id'=s::text
      AND actor_id='72000000-0000-4000-8000-000000000002' AND after_data->>'finish_reason'='Owner left the workshop'),
    'abandoned closure has one attributable audit record');
  PERFORM pg_temp.assert_true((SELECT count(*)=movement_count FROM public.amp_inventory_movements)
    AND EXISTS (SELECT 1 FROM public.amp_stock_counts sc JOIN public.amp_inventory_events e ON e.id=sc.event_id
      WHERE sc.batch_id=s AND e.actor_id='72000000-0000-4000-8000-000000000001'),
    'abandoned closure leaves stock and original count attribution intact');
END $$;
RESET ROLE;
-- Maintainer staff-access helpers work by email address.
INSERT INTO auth.users(id, email) VALUES
  ('71300000-0000-4000-8000-000000000001', 'new.staff@example.test'),
  ('71300000-0000-4000-8000-000000000002', 'leaving.staff@example.test');
DO $$ DECLARE v_id uuid; BEGIN
  v_id := app.grant_staff_access('new.staff@example.test', 'New Staff');
  PERFORM pg_temp.assert_true(v_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM app.staff_members WHERE id = v_id AND is_active AND display_name = 'New Staff'),
    'grant creates an active membership by email');
  PERFORM pg_temp.assert_true(EXISTS
    (SELECT 1 FROM app.audit_log WHERE table_name = 'staff_members' AND action = 'INSERT' AND row_key->>'id' = v_id::text),
    'grant is audited');
  PERFORM pg_temp.expect_error($q$SELECT app.grant_staff_access('NEW.STAFF@EXAMPLE.TEST', 'Again')$q$, 'STAFF_ALREADY_ACTIVE');
  PERFORM pg_temp.expect_error($q$SELECT app.grant_staff_access('ghost@example.test', 'Ghost')$q$, 'STAFF_USER_NOT_FOUND');
  PERFORM pg_temp.expect_error($q$SELECT app.grant_staff_access('  ', 'Blank')$q$, 'STAFF_EMAIL_REQUIRED');
  PERFORM pg_temp.expect_error(format('SELECT app.grant_staff_access(%L, %L)', 'ghost@example.test', repeat('n', 121)), 'STAFF_DISPLAY_NAME_REQUIRED');
  -- revoke / re-grant lifecycle (each volatile call gets its own statement:
  -- AND operands have no guaranteed evaluation order, so a state read in the
  -- same expression could run before the call it verifies)
   PERFORM pg_temp.assert_true(app.revoke_staff_access('new.staff@example.test') = v_id, 'revoke returns the membership id');
   PERFORM pg_temp.assert_true(NOT (SELECT is_active FROM app.staff_members WHERE id = v_id), 'revoke deactivates');
   PERFORM pg_temp.expect_error($q$SELECT app.revoke_staff_access('new.staff@example.test')$q$, 'STAFF_NOT_ACTIVE');
   PERFORM pg_temp.expect_error($q$SELECT app.revoke_staff_access('ghost@example.test')$q$, 'STAFF_USER_NOT_FOUND');
   PERFORM pg_temp.assert_true(app.grant_staff_access('new.staff@example.test', 'Renamed Staff') = v_id, 're-grant returns the same membership');
   PERFORM pg_temp.assert_true((SELECT is_active AND display_name = 'Renamed Staff' FROM app.staff_members WHERE id = v_id),
    're-grant reactivates with the new name');
END $$;
-- API roles cannot execute maintainer helpers at all.
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error($q$SELECT app.grant_staff_access('new.staff@example.test', 'X')$q$, 'denied');
SELECT pg_temp.expect_error($q$SELECT app.revoke_staff_access('new.staff@example.test')$q$, 'denied');
RESET ROLE;
-- ON DELETE SET NULL must also make an otherwise-active owner recoverable.
UPDATE app.staff_members SET is_active=true WHERE id='72000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id='71000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT public.amp_close_abandoned_count_batch(gen_random_uuid(),current_setting('test.deleted_auth_batch')::uuid,'Auth account removed');
SELECT pg_temp.assert_true((SELECT finished_at IS NOT NULL FROM public.amp_count_batches
  WHERE id=current_setting('test.deleted_auth_batch')::uuid),'batch is recoverable after Auth-account deletion');
RESET ROLE;
ROLLBACK;
