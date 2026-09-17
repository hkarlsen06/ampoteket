-- Malformed input must reject without leaving plausible partial state.
-- Run only in a disposable local database. Every fixture is rolled back.
\set ON_ERROR_STOP on
BEGIN;
\ir fixtures.sql
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- Include every app table, not just the stock balance. Sequence gaps are allowed.
CREATE FUNCTION pg_temp.app_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t record; v_hash text; v_state jsonb := '{}'::jsonb;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename LOOP
    EXECUTE format('SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,
      E''\n'' ORDER BY to_jsonb(r)::text),''''),''UTF8'')),''hex'') FROM app.%I r',t.tablename)
      INTO v_hash;
    v_state:=v_state||jsonb_build_object(t.tablename,v_hash);
  END LOOP;
  RETURN v_state;
END $$;
CREATE FUNCTION pg_temp.reject_unchanged(p_sql text,p_message text,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_before jsonb := pg_temp.app_snapshot(); v_error text;
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;
  END;
  IF v_error IS NULL THEN RAISE EXCEPTION 'FAIL: % accepted invalid input',p_label; END IF;
  IF position(p_message in v_error)=0 THEN
    RAISE EXCEPTION 'FAIL: % expected %, got %',p_label,p_message,v_error;
  END IF;
  IF pg_temp.app_snapshot() IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL: % left changed application rows',p_label;
  END IF;
  RAISE NOTICE 'PASS: % rejected and every app table remained unchanged',p_label;
END $$;

DO $$
DECLARE r uuid := '73000000-0000-4000-8000-000000000001';
  c uuid := '73000000-0000-4000-8000-000000000002';
  token text := repeat('ab',32); body jsonb; v_case record; v_order uuid; v_lines uuid[];
BEGIN
  FOR v_case IN SELECT * FROM (VALUES
    (NULL::jsonb,'ITEMS_MUST_BE_ARRAY','SQL-null items'),
    ('null'::jsonb,'ITEMS_MUST_BE_ARRAY','JSON-null items'),
    ('{}'::jsonb,'ITEMS_MUST_BE_ARRAY','object instead of array'),
    ('"items"'::jsonb,'ITEMS_MUST_BE_ARRAY','string instead of array'),
    ('[]'::jsonb,'INVALID_ITEM_COUNT','empty items'),
    ('[null]'::jsonb,'INVALID_ITEM','null item'),
    ('[1]'::jsonb,'INVALID_ITEM','numeric item'),
    ('[[]]'::jsonb,'INVALID_ITEM','array item')
  ) q(value,message,label) LOOP
    PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_prepare_checkout(%L,%L,%L::jsonb)',
      gen_random_uuid(),token,v_case.value),v_case.message,v_case.label);
  END LOOP;
  SELECT jsonb_agg('{}'::jsonb) INTO body FROM generate_series(1,201);
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_prepare_checkout(%L,%L,%L::jsonb)',
    gen_random_uuid(),token,body),'INVALID_ITEM_COUNT','201-item request');

  FOR v_case IN SELECT * FROM (VALUES
    ('[{"quantity":"1"}]'::jsonb,'PRODUCT_ID_REQUIRED','missing product UUID'),
    ('[{"product_id":"broken","quantity":"1"}]'::jsonb,'invalid input syntax for type uuid','malformed product UUID'),
    ('[{"product_id":"ffffffff-ffff-4fff-8fff-ffffffffffff","quantity":"1"}]'::jsonb,
      'PRODUCT_NOT_FOUND','unknown product UUID')
  ) q(value,message,label) LOOP
    PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_record_receipt(%L,%L::jsonb,NULL,%L)',
      gen_random_uuid(),v_case.value,'Input fixture'),v_case.message,v_case.label);
  END LOOP;

  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
    jsonb_build_object('product_id',r,'quantity','2'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_prepare_checkout(%L,%L,%L::jsonb)',
    gen_random_uuid(),token,body),'DUPLICATE_OR_MISSING_CART_PRODUCT','duplicate checkout product');

  FOR v_case IN SELECT * FROM (VALUES
    ('not-numeric','invalid input syntax for type numeric','malformed quantity'),
    (NULL::text,'QUANTITY_REQUIRED','null quantity'),
    ('-1','POSITIVE_RECEIPT_QUANTITY_REQUIRED','negative receipt quantity'),
    ('0','POSITIVE_RECEIPT_QUANTITY_REQUIRED','zero receipt quantity'),
    ('0.0001','INVALID_QUANTITY_STEP','off-step cable quantity')
  ) q(value,message,label) LOOP
    body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
      jsonb_build_object('product_id',c,'quantity',v_case.value));
    PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_record_receipt(%L,%L::jsonb,NULL,%L)',
      gen_random_uuid(),body,'Input fixture'),v_case.message,'bad second receipt line: '||v_case.label);
  END LOOP;

  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1','unit_cost_nok','1'),
    jsonb_build_object('product_id',c,'quantity','1','unit_cost_nok','not-a-price'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_record_order(%L,%L,clock_timestamp(),%L::jsonb)',
    gen_random_uuid(),'Input fixture',body),'invalid input syntax for type numeric','bad second order price');
  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1','unit_cost_nok','-0.01'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_record_order(%L,%L,clock_timestamp(),%L::jsonb)',
    gen_random_uuid(),'Input fixture',body),'unit_price_check','negative order price');
  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1','unit_cost_nok','1'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_record_order(%L,%L,clock_timestamp(),%L::jsonb,1.001)',
    gen_random_uuid(),'Input fixture',body),'nok_amount_check','additional-cost excess precision');

  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity_delta','1'),
    jsonb_build_object('product_id',c,'quantity_delta','not-numeric'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_adjust_stock(%L,%L::jsonb,%L)',
    gen_random_uuid(),body,'Input fixture'),'invalid input syntax for type numeric','bad second manual adjustment');
  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
    jsonb_build_object('product_id',c,'quantity','-1'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_withdraw_stock(%L,%L::jsonb,%L)',
    gen_random_uuid(),body,'Input fixture'),'INVALID_WITHDRAWAL','bad second withdrawal');
  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
    jsonb_build_object('product_id',c,'quantity','0.01'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_prepare_checkout(%L,%L,%L::jsonb)',
    gen_random_uuid(),token,body),'INVALID_QUANTITY_STEP','bad second checkout line');

  body:=jsonb_build_array(jsonb_build_object('product_id',r,'quantity','10','unit_cost_nok','1'),
    jsonb_build_object('product_id',c,'quantity','1','unit_cost_nok','1'));
  v_order:=(public.amp_record_order(gen_random_uuid(),'Cancellation fixture',clock_timestamp(),body)->>'order_id')::uuid;
  SELECT array_agg(id ORDER BY line_number) INTO v_lines FROM app.purchase_order_lines WHERE order_id=v_order;
  body:=jsonb_build_array(jsonb_build_object('order_line_id',v_lines[1],'quantity','1'),
    jsonb_build_object('order_line_id',v_lines[2],'quantity','2'));
  PERFORM pg_temp.reject_unchanged(format('SELECT public.amp_cancel_order_quantities(%L,%L,%L::jsonb,%L)',
    gen_random_uuid(),v_order,body,'Input fixture'),'INVALID_CANCELLATION_QUANTITY','bad second cancellation');
END $$;
ROLLBACK;
