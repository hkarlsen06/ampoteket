-- Regressions for semantic failures found in the 2026-09-19 design audit.
-- Disposable database only; all fixtures and mutations roll back.
\set ON_ERROR_STOP on
BEGIN;
\ir fixtures.sql
CREATE FUNCTION pg_temp.audit_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END $$;
CREATE FUNCTION pg_temp.audit_error(statement text,expected text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected in SQLERRM)=0 THEN RAISE EXCEPTION 'Expected %, got %',expected,SQLERRM; END IF;
    RAISE NOTICE 'PASS: rejected with %',expected; RETURN;
  END;
  RAISE EXCEPTION 'Expected failure: %',expected;
END $$;
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE p uuid := '73000000-0000-4000-8000-000000000001'; o uuid; l uuid;
  movement bigint; rev bigint; request uuid; result jsonb; event_count bigint;
BEGIN
  o := (public.amp_record_order(gen_random_uuid(),'Audit supplier','2026-01-01T00:00:00Z',
    jsonb_build_array(jsonb_build_object('product_id',p,'quantity','100','unit_cost_nok','1')))->>'order_id')::uuid;
  SELECT id INTO l FROM public.amp_purchase_order_lines WHERE order_id=o;
  result := public.amp_record_receipt(gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',p,'order_line_id',l,'quantity','60')),o);
  SELECT id INTO movement FROM public.amp_inventory_movements WHERE event_id=(result->>'event_id')::uuid;
  SELECT revision INTO rev FROM public.amp_inventory WHERE product_id=p;
  -- A matching count posts no movement and leaves the stock revision unchanged,
  -- but it still establishes a physical observation that a later fix must respect.
  PERFORM public.amp_record_single_count(gen_random_uuid(),p,rev,60,'All sixty physically present');
  PERFORM pg_temp.audit_assert((SELECT revision=rev AND quantity=60 FROM public.amp_inventory WHERE product_id=p),
    'zero-difference count retains its observation without advancing movement revision');
  PERFORM pg_temp.audit_error(format('SELECT public.amp_adjust_stock(%L,%L::jsonb,%L)',gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',p,'quantity_delta','-50','corrects_movement_id',movement::text,'expected_revision',rev::text)),
    'Correction discovered after a matching count'),'CORRECTION_REQUIRES_RECOUNT');
  PERFORM public.amp_record_single_count(gen_random_uuid(),p,rev,10,'Only ten physically present');
  SELECT revision INTO rev FROM public.amp_inventory WHERE product_id=p;
  PERFORM pg_temp.audit_error(format('SELECT public.amp_adjust_stock(%L,%L::jsonb,%L)',gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',p,'quantity_delta','-50','corrects_movement_id',movement::text,'expected_revision',rev::text)),
    'Original receipt should be ten'),'CORRECTION_REQUIRES_RECOUNT');
  SELECT count(*) INTO event_count FROM public.amp_inventory_events;
  PERFORM pg_temp.audit_error(format('SELECT public.amp_correct_movement_and_count(%L,%s,%s,-61,10,%L)',gen_random_uuid(),movement,rev,'Bad correction'),
    'RECEIPT_CORRECTION_OUT_OF_RANGE');
  PERFORM pg_temp.audit_assert((SELECT count(*)=event_count FROM public.amp_inventory_events)
    AND (SELECT quantity=10 FROM public.amp_inventory WHERE product_id=p),'failed recount recovery leaves no partial events');
  request := gen_random_uuid();
  result := public.amp_correct_movement_and_count(request,movement,rev,-50,10,'Fresh count; original receipt was ten');
  PERFORM pg_temp.audit_assert(result=public.amp_correct_movement_and_count(request,movement,rev,-50,10,'Fresh count; original receipt was ten'),
    'correction and recount retries return the same events');
  PERFORM pg_temp.audit_assert((SELECT quantity=10 FROM public.amp_inventory WHERE product_id=p)
    AND (SELECT received_quantity=10 AND outstanding_quantity=90 FROM public.amp_purchase_line_progress WHERE id=l),
    'old receipt correction fixes fulfillment and retains observed stock');
  PERFORM pg_temp.audit_assert((SELECT count(*)=event_count+2 FROM public.amp_inventory_events)
    AND (SELECT count(*)=3 FROM public.amp_stock_counts WHERE product_id=p),'recovery preserves all physical observations');
  SELECT revision INTO rev FROM public.amp_inventory WHERE product_id=p;
  PERFORM pg_temp.audit_error(format('SELECT public.amp_adjust_stock(%L,%L::jsonb,%L)',gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',p,'quantity_delta','1','corrects_movement_id',movement::text)),
    'Missing revision'),'CORRECTION_REVISION_REQUIRED');
END $$;

-- Physical retirement frees real coordinates and keeps the original audit trail.
DO $$
DECLARE c uuid; b uuid; replacement uuid; archived_before bigint;
BEGIN
  INSERT INTO public.amp_cabinets(code,outer_row,outer_col,inner_rows,inner_cols)
    VALUES('RETIRE-CAB',3,1,2,2) RETURNING id INTO c;
  INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col)
    VALUES('RETIRE-BIN',c,1,1) RETURNING id INTO b;
  PERFORM pg_temp.audit_error(format('UPDATE public.amp_cabinets SET is_archived=true WHERE id=%L',c),'CABINET_STILL_HAS_BINS');
  UPDATE public.amp_bins SET is_archived=true WHERE id=b;
  PERFORM pg_temp.audit_assert((SELECT is_archived AND cabinet_id IS NULL AND inner_row IS NULL FROM public.amp_bins WHERE id=b)
    AND EXISTS (SELECT 1 FROM public.amp_audit_log WHERE table_name='bins' AND row_key->>'id'=b::text
      AND before_data->>'cabinet_id'=c::text AND after_data->>'is_archived'='true'),'bin retirement preserves history and releases coordinates');
  INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col,row_span,col_span)
    VALUES('REPLACEMENT-BIN',c,1,1,1,2) RETURNING id INTO replacement;
  PERFORM pg_temp.audit_error(format('UPDATE public.amp_products SET bin_id=%L WHERE code=''TEST-R''',b),'PRODUCT_BIN_UNAVAILABLE');
  PERFORM pg_temp.audit_error('UPDATE public.amp_bins SET is_archived=true WHERE code=''TEST-BIN-1''','BIN_STILL_HAS_PRODUCTS');
  UPDATE public.amp_bins SET is_archived=true WHERE id=replacement;
  UPDATE public.amp_cabinets SET is_archived=true WHERE id=c;
  PERFORM pg_temp.audit_assert((SELECT is_archived AND outer_row IS NULL AND outer_col IS NULL FROM public.amp_cabinets WHERE id=c)
    AND NOT EXISTS (SELECT 1 FROM public.amp_cabinet_free_cells WHERE cabinet_id=c),'empty cabinet retires and disappears from free-cell map');
  INSERT INTO public.amp_cabinets(code,outer_row,outer_col,inner_rows,inner_cols)
    VALUES('REPLACEMENT-CAB',3,1,2,2);
  PERFORM pg_temp.audit_error(format('INSERT INTO public.amp_bins(code,cabinet_id,inner_row,inner_col) VALUES(''BAD-ARCHIVE'',%L,1,1)',c),
    'CABINET_ARCHIVED');
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),
  '[{"product_id":"73000000-0000-4000-8000-000000000001","quantity":"2"}]')->>'checkout_id' AS recover_checkout \gset
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('test.recovered',:'recover_checkout',true);
DO $$ DECLARE co uuid := current_setting('test.recovered')::uuid; req uuid:=gen_random_uuid(); result jsonb; BEGIN
  PERFORM pg_temp.audit_error(format('SELECT public.amp_recover_checkout(%L,%L,%L)',gen_random_uuid(),co,' '),'RECOVERY_REASON_REQUIRED');
  result := public.amp_recover_checkout(req,co,'Buyer identified original checkout at shelf; browser storage lost');
  PERFORM pg_temp.audit_assert(result=public.amp_recover_checkout(req,co,'Buyer identified original checkout at shelf; browser storage lost'),
    'staff recovery retries return the same sale');
  PERFORM pg_temp.audit_assert((SELECT count(*)=1 FROM public.amp_sales WHERE checkout_id=co)
    AND EXISTS (SELECT 1 FROM public.amp_sales WHERE checkout_id=co AND recovered_by='72000000-0000-4000-8000-000000000001'
      AND recovery_reason IS NOT NULL),'staff recovery is attributable on the original sale identity');
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.amp_confirm_checkout(:'recover_checkout',repeat('ab',32));
RESET ROLE;
SELECT pg_temp.audit_assert((SELECT quantity=8 FROM app.inventory WHERE product_id='73000000-0000-4000-8000-000000000001'),
  'original browser confirmation after recovery cannot withdraw twice');

-- Free items are a registration with no payment claim.
UPDATE app.products SET sale_unit_price_nok=0 WHERE code='TEST-R';
SET LOCAL ROLE service_role;
SELECT public.amp_prepare_checkout(gen_random_uuid(),repeat('cd',32),
  '[{"product_id":"73000000-0000-4000-8000-000000000001","quantity":"1"}]')->>'checkout_id' AS free_checkout \gset
SELECT pg_temp.audit_assert(public.amp_get_checkout(:'free_checkout',repeat('cd',32))->>'payment_required'='false',
  'zero-total checkout explicitly requires no payment');
SELECT public.amp_confirm_checkout(:'free_checkout',repeat('cd',32));
RESET ROLE;
SELECT pg_temp.audit_assert((SELECT quantity=7 FROM app.inventory WHERE product_id='73000000-0000-4000-8000-000000000001'),
  'free registration still withdraws physical stock exactly once');
ROLLBACK;
