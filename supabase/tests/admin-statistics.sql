-- Staff-only, exact registered-sale reporting. Disposable fixtures only.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'Pacific/Honolulu';
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
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error was not raised: %',p_message;
END $$;
\ir fixtures.sql
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- Historical timestamps are inserted as fixture facts; immutable rows are never
-- rewritten and each sale still has its matching checkout and stock movements.
CREATE FUNCTION pg_temp.register_at(p_items jsonb,p_recorded_at timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_checkout uuid; v_event uuid;
BEGIN
  v_checkout := (public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),p_items)->>'checkout_id')::uuid;
  INSERT INTO app.inventory_events(kind,recorded_at,occurred_at)
    VALUES('sale',p_recorded_at,p_recorded_at-interval '90 days') RETURNING id INTO v_event;
  INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
    SELECT v_event,product_id,-quantity FROM app.checkout_lines WHERE checkout_id=v_checkout;
  INSERT INTO app.sales(checkout_id,event_id) VALUES(v_checkout,v_event);
END $$;

DO $$
DECLARE r uuid := '73000000-0000-4000-8000-000000000001';
  c uuid := '73000000-0000-4000-8000-000000000002';
  v_today date := (statement_timestamp() AT TIME ZONE 'Europe/Oslo')::date;
  v_start timestamptz := (v_today-29)::timestamp AT TIME ZONE 'Europe/Oslo';
  v_items jsonb := jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
    jsonb_build_object('product_id',c,'quantity','0.1'));
  j jsonb; scoped jsonb; before_correction jsonb; v_checkout uuid; v_movement bigint;
  v_batch uuid; v_oldest uuid; v_new_product uuid; v_expected numeric;
BEGIN
  j := public.amp_admin_statistics();
  PERFORM pg_temp.assert_true(j->>'start_date'=(v_today-29)::text AND j->>'end_date'=v_today::text
    AND jsonb_array_length(j->'days')=30 AND j#>>'{summary,sale_count}'='0'
    AND j#>>'{summary,total_nok}'='0.00' AND j#>'{summary,quantity}'='null'::jsonb
    AND j->'products'='[]'::jsonb,
    'empty global statistics return exact zeros and 30 Oslo calendar days independently of session timezone');
  PERFORM pg_temp.assert_true((SELECT bool_and(day->>'date'=(v_today-30+ordinality::int)::text
    AND day->>'sale_count'='0' AND day->>'total_nok'='0.00' AND day->'quantity'='null'::jsonb)
    FROM jsonb_array_elements(j->'days') WITH ORDINALITY AS d(day,ordinality)),
    'daily rows are consecutive, sorted and zero-filled with no mixed-unit quantity');
  scoped := public.amp_admin_statistics(r);
  PERFORM pg_temp.assert_true(scoped->>'product_id'=r::text AND scoped#>>'{summary,quantity}'='0'
    AND scoped->'overview'='null'::jsonb AND scoped->'products'='[]'::jsonb,
    'existing product without sales has a valid empty scoped report');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_admin_statistics(%L)',gen_random_uuid()),'PRODUCT_NOT_FOUND');

  UPDATE app.products SET sale_unit_price_nok=CASE WHEN id=r THEN 0.005 ELSE 0.05 END;
  PERFORM public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),v_items);
  PERFORM pg_temp.assert_true(public.amp_admin_statistics()#>>'{summary,sale_count}'='0',
    'preparing a checkout never counts as a registered sale');
  v_checkout := (public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),v_items)->>'checkout_id')::uuid;
  PERFORM public.amp_recover_checkout(gen_random_uuid(),v_checkout,'Synthetic staff recovery');
  PERFORM public.amp_confirm_checkout(v_checkout,repeat('ab',32));
  PERFORM pg_temp.register_at(v_items,v_start);
  PERFORM pg_temp.register_at(v_items,v_start-interval '1 microsecond');
  PERFORM pg_temp.register_at(v_items,(v_today+1)::timestamp AT TIME ZONE 'Europe/Oslo');
  PERFORM pg_temp.register_at(v_items,((v_today-28)::timestamp+interval '30 minutes') AT TIME ZONE 'Europe/Oslo');
  UPDATE app.products SET sale_unit_price_nok=99,is_active=false WHERE id=r;

  j := public.amp_admin_statistics();
  PERFORM pg_temp.assert_true(j#>>'{summary,sale_count}'='3' AND j#>>'{summary,total_nok}'='0.06'
    AND j#>>'{days,0,sale_count}'='1' AND j#>>'{days,1,sale_count}'='1'
    AND j#>>'{days,29,sale_count}'='1' AND j#>>'{days,2,sale_count}'='0',
    'recorded Oslo dates include the first midnight, exclude both outer boundaries, and round each frozen line before summing');
  scoped := public.amp_admin_statistics(r);
  PERFORM pg_temp.assert_true(scoped#>>'{summary,sale_count}'='3'
    AND scoped#>>'{summary,total_nok}'='0.03' AND scoped#>>'{summary,quantity}'='3'
    AND (public.amp_admin_statistics(c)#>>'{summary,quantity}')::numeric=0.3
    AND j#>>'{products,0,code}'='TEST-C' AND j#>>'{products,1,code}'='TEST-R',
    'scoped reports filter lines, retain inactive products and original prices; equal-value products sort by code');
  PERFORM pg_temp.assert_true(jsonb_typeof(scoped#>'{summary,sale_count}')='string'
    AND jsonb_typeof(scoped#>'{summary,total_nok}')='string'
    AND jsonb_typeof(scoped#>'{summary,quantity}')='string'
    AND jsonb_typeof(j#>'{products,0,quantity}')='string',
    'counts, money and product quantities are JSON strings');
  before_correction := scoped;
  SELECT m.id INTO v_movement FROM app.inventory_movements m JOIN app.sales s ON s.event_id=m.event_id
    WHERE s.checkout_id=v_checkout AND m.product_id=r;
  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(jsonb_build_object(
    'product_id',r,'quantity_delta','1','corrects_movement_id',v_movement,
    'expected_revision',(SELECT revision::text FROM app.inventory WHERE product_id=r))),
    'Correct synthetic stock withdrawal');
  PERFORM pg_temp.assert_true(public.amp_admin_statistics(r)=before_correction,
    'linked stock corrections do not rewrite registered-sale statistics');

  UPDATE app.products SET sale_unit_price_nok=999999999998.999999,is_active=true WHERE id=r;
  v_checkout := (public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','999999999999')))->>'checkout_id')::uuid;
  PERFORM public.amp_confirm_checkout(v_checkout,repeat('ab',32));
  scoped := public.amp_admin_statistics(r);
  v_expected := round(999999999999::numeric*999999999998.999999,2)+0.03;
  PERFORM pg_temp.assert_true(scoped#>>'{summary,total_nok}'=v_expected::text
    AND scoped#>>'{summary,quantity}'='1000000000002',
    'large cumulative quantities and monetary totals remain exact beyond JavaScript numeric precision');
  UPDATE app.products SET is_active=false WHERE id=r;

  v_items := '[]'::jsonb;
  FOR i IN 1..11 LOOP
    INSERT INTO app.products(code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
      VALUES('STAT-'||lpad(i::text,2,'0'),'Statistikkdel','Statistics part',
        '75000000-0000-4000-8000-000000000001','pcs',1,1,0.01,true) RETURNING id INTO v_new_product;
    v_items := v_items||jsonb_build_array(jsonb_build_object('product_id',v_new_product,'quantity','1'));
  END LOOP;
  v_checkout := (public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),v_items)->>'checkout_id')::uuid;
  PERFORM public.amp_confirm_checkout(v_checkout,repeat('ab',32));
  -- Two zero balances sort after every negative balance, irrespective of code.
  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(
    jsonb_build_object('product_id',(SELECT id FROM app.products WHERE code='STAT-01'),'quantity_delta','1'),
    jsonb_build_object('product_id',(SELECT id FROM app.products WHERE code='STAT-02'),'quantity_delta','1')),'Synthetic replenishment');
  FOR i IN 1..7 LOOP
    v_batch := (public.amp_start_count_batch(gen_random_uuid(),'Statistics count '||i)->>'batch_id')::uuid;
    IF i=1 THEN v_oldest := v_batch; END IF;
  END LOOP;
  PERFORM public.amp_finish_count_batch(v_batch);
  j := public.amp_admin_statistics();
  PERFORM pg_temp.assert_true(jsonb_array_length(j->'products')=10
    AND j#>>'{products,0,code}'='TEST-R' AND j#>>'{products,1,code}'='TEST-C'
    AND j#>>'{products,2,code}'='STAT-01' AND j#>>'{products,9,code}'='STAT-08',
    'top products retain historical inactive sales, rank by exact value and limit ties deterministically');
  PERFORM pg_temp.assert_true(j#>>'{overview,attention_count}'='12'
    AND jsonb_array_length(j#>'{overview,attention}')=8
    AND j#>>'{overview,attention,0,code}'='STAT-03'
    AND j#>>'{overview,attention,7,code}'='STAT-10'
    AND j#>>'{overview,open_count_count}'='6'
    AND jsonb_array_length(j#>'{overview,open_counts}')=5
    AND j#>>'{overview,open_counts,0,id}'=v_oldest::text,
    'overview counts complete active shortages/open batches and limits negative-first/oldest-first action lists');

  PERFORM pg_temp.expect_error('UPDATE app.products SET minimum_stock=1.5 WHERE code=''STAT-01''','violates check constraint');
  PERFORM pg_temp.expect_error('UPDATE app.products SET minimum_stock=-1 WHERE code=''STAT-01''','violates check constraint');
  -- Below minimum follows every sold-out product, ordered by share of the minimum;
  -- stock equal to the minimum is not low.
  PERFORM public.amp_adjust_stock(gen_random_uuid(),jsonb_build_array(
    jsonb_build_object('product_id',(SELECT id FROM app.products WHERE code='STAT-01'),'quantity_delta','3'),
    jsonb_build_object('product_id',(SELECT id FROM app.products WHERE code='STAT-02'),'quantity_delta','2'),
    jsonb_build_object('product_id',(SELECT id FROM app.products WHERE code='STAT-11'),'quantity_delta','5')),'Synthetic minimum check');
  UPDATE app.products SET minimum_stock=4 WHERE code IN ('STAT-01','STAT-11');
  UPDATE app.products SET minimum_stock=8 WHERE code='STAT-02';
  UPDATE app.products SET is_active=false WHERE code BETWEEN 'STAT-03' AND 'STAT-10';
  j := public.amp_admin_statistics();
  PERFORM pg_temp.assert_true(j#>>'{overview,attention_count}'='3'
    AND (SELECT quantity FROM app.inventory WHERE product_id=(j#>>'{overview,attention,0,product_id}')::uuid)<=0
    AND j#>>'{overview,attention,1,code}'='STAT-02' AND j#>>'{overview,attention,1,minimum_stock}'='8'
    AND j#>>'{overview,attention,2,code}'='STAT-01' AND j#>>'{overview,attention,2,quantity}'='3',
    'overview lists active products below their minimum after sold-out products, most depleted first');
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(public.amp_admin_statistics() IS NOT NULL,'real authenticated active staff can read statistics');
RESET ROLE;
UPDATE app.staff_members SET is_active=false WHERE id='72000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.amp_admin_statistics()','STAFF_REQUIRED');
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
SELECT pg_temp.expect_error('SELECT public.amp_admin_statistics()','STAFF_REQUIRED');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_error('SELECT public.amp_admin_statistics()','permission denied');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_error('SELECT public.amp_admin_statistics()','permission denied');
RESET ROLE;
ROLLBACK;
