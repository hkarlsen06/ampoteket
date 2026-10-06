-- Exact transport, aggregate closure, monetary rounding and complete reads.
-- Disposable local database only; synthetic fixture rows are rolled back.
\set ON_ERROR_STOP on
BEGIN;
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

DO $$
DECLARE r uuid := '73000000-0000-4000-8000-000000000001';
  c uuid := '73000000-0000-4000-8000-000000000002';
  j jsonb; v_checkout uuid; v_revision bigint; v_expected numeric; v_count bigint;
  v_req uuid; v_bad text;
BEGIN
  UPDATE app.products SET sale_unit_price_nok=999999999998.999999 WHERE id=r;
  UPDATE app.product_attributes SET number_value=999999999998.999999 WHERE product_id=r;
  SELECT to_jsonb(cat) INTO j FROM public.amp_catalog('TEST-R') cat;
  PERFORM pg_temp.assert_true(jsonb_typeof(j->'sale_unit_price_nok')='string'
    AND j->>'sale_unit_price_nok'='999999999998.999999'
    AND jsonb_typeof(j->'quantity')='string' AND jsonb_typeof(j->'sale_step')='string',
    'catalog transports exact price, balance and step as JSON strings');
  PERFORM pg_temp.assert_true(j#>>'{attributes,test_resistance,value}'='999999999998.999999'
    AND jsonb_typeof(j#>'{attributes,test_resistance,value}')='string'
    AND j#>>'{attributes,test_resistance,value_type}'='number',
    'numeric attributes preserve exact value and declared type');
  PERFORM pg_temp.assert_true(j->>'name_nb'='Testmotstand' AND j->>'name_en'='Test resistor'
    AND NOT (j ? 'name') AND NOT (j ? 'area_code'),
    'catalog publishes both language names and no area level');

  -- Both the saved expected balance and the generated difference must fit.
  PERFORM public.amp_record_receipt(gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','999999999999')),NULL,'Boundary receipt');
  PERFORM public.amp_record_receipt(gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1')),NULL,'Boundary receipt');
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=r;
  j:=public.amp_record_single_count(gen_random_uuid(),r,v_revision,1,'Boundary count');
  PERFORM pg_temp.assert_true((SELECT expected_quantity=1000000000000 AND counted_quantity=1
    FROM app.stock_counts WHERE event_id=(j->>'event_id')::uuid),
    'count stores an expected balance larger than one command');
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=r;
  j:=public.amp_record_single_count(gen_random_uuid(),r,v_revision,1000000000001,'Large physical count');
  PERFORM pg_temp.assert_true((SELECT quantity=1000000000001 FROM app.inventory WHERE product_id=r)
    AND (j->>'difference')::numeric=1000000000000,
    'large physical counts and count-generated differences remain representable');
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=r;
  PERFORM public.amp_record_single_count(gen_random_uuid(),r,v_revision,0,'Reset physical observation');
  PERFORM public.amp_withdraw_stock(gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','999999999999')),'Boundary withdrawal');
  PERFORM public.amp_withdraw_stock(gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','999999999999')),'Boundary withdrawal');
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=r;
  j:=public.amp_record_single_count(gen_random_uuid(),r,v_revision,1,'Recover negative balance');
  PERFORM pg_temp.assert_true((SELECT quantity=1 FROM app.inventory WHERE product_id=r)
    AND (j->>'difference')::numeric=1999999999999,
    'count can recover cumulative negative balances without extra adjustments');

  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_receipt(%L,%L::jsonb,NULL,%L)',
    gen_random_uuid(),jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1000000000000')),
    'Oversized command'),'quantity_check');
  FOREACH v_bad IN ARRAY ARRAY['NaN','Infinity','-Infinity','0.0000001'] LOOP
    PERFORM pg_temp.expect_error(format('SELECT %L::numeric::app.stock_quantity',v_bad),'stock_quantity_check');
  END LOOP;
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=c;
  SELECT count(*) INTO v_count FROM app.command_requests;
  v_req:=gen_random_uuid();
  PERFORM pg_temp.expect_error(format('SELECT public.amp_record_single_count(%L,%L,%s,0.0000001)',
    v_req,c,v_revision),'stock_quantity_check');
  PERFORM pg_temp.assert_true((SELECT count(*)=v_count FROM app.command_requests)
    AND NOT EXISTS (SELECT 1 FROM app.count_batches WHERE request_id=v_req),
    'invalid count precision rolls back command and count batch');

  -- Rounding each different product line is intentional: 0.01 + 0.01 = 0.02.
  UPDATE app.products SET sale_unit_price_nok=0.005 WHERE id IN (r,c);
  j:=public.amp_prepare_checkout(gen_random_uuid(),repeat('ab',32),
    jsonb_build_array(jsonb_build_object('product_id',r,'quantity','1'),
      jsonb_build_object('product_id',c,'quantity','1')));
  v_checkout:=(j->>'checkout_id')::uuid;
  j:=public.amp_get_checkout(v_checkout,repeat('ab',32));
  PERFORM pg_temp.assert_true(j->>'total_nok'='0.02'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'items') x WHERE x->>'line_total_nok'<>'0.01'),
    'half-ore ties round per complete product line before summation');
END $$;

-- More than the usual Data API row cap: every keyset page must be consumable.
INSERT INTO app.products(code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
SELECT 'TEST-P'||lpad(i::text,4,'0'),'Paginering-fikstur','Pagination fixture',
  '75000000-0000-4000-8000-000000000001','pcs',1,1,0,true
FROM generate_series(1,1103) i;
-- Sorted by a repeated primary value with gaps, so ties and missing values cross pages.
INSERT INTO app.categories(id,name) VALUES('77000000-0000-4000-8000-000000000001','Sort fixtures');
UPDATE app.products SET category_id='77000000-0000-4000-8000-000000000001' WHERE code LIKE 'TEST-P%';
INSERT INTO app.product_attributes(product_id,attribute_id,number_value)
SELECT id,'76000000-0000-4000-8000-000000000001',(substr(code,7)::integer%13)::numeric/10
FROM app.products WHERE code LIKE 'TEST-P%' AND substr(code,7)::integer%2=1;
CREATE TEMP TABLE seen_catalog(position serial,code text UNIQUE);
DO $$
DECLARE v_after text; v_rows integer; v_page integer := 0;
BEGIN
  LOOP
    WITH page AS (SELECT cat.code,cat.ordinality AS ord FROM public.amp_catalog(NULL,v_after,37,
        p_sort=>'[["Other",null],["Sort fixtures","test_resistance"]]') WITH ORDINALITY cat),
      inserted AS (INSERT INTO seen_catalog(code) SELECT code FROM page ORDER BY ord RETURNING code)
    SELECT count(*),(SELECT code FROM page ORDER BY ord DESC LIMIT 1) INTO v_rows,v_after FROM inserted;
    EXIT WHEN v_rows=0;
    v_page:=v_page+1;
    IF v_page>100 THEN RAISE EXCEPTION 'Pagination did not advance'; END IF;
  END LOOP;
  PERFORM pg_temp.assert_true((SELECT count(*) FROM seen_catalog)=(SELECT count(*) FROM app.products WHERE is_active),
    'keyset pagination reads every active product beyond 1000 without duplicates');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM (
      SELECT s.code,lag(s.code) OVER w AS previous_code,a.number_value,lag(a.number_value) OVER w AS previous_value,
        lag(a.number_value IS NULL) OVER w AS previous_missing
      FROM seen_catalog s JOIN app.products p ON p.code=s.code
      LEFT JOIN app.product_attributes a ON a.product_id=p.id AND a.attribute_id='76000000-0000-4000-8000-000000000001'
      WHERE s.code LIKE 'TEST-P%' WINDOW w AS (ORDER BY s.position)) o
    WHERE o.previous_missing AND o.number_value IS NOT NULL
      OR o.number_value<o.previous_value
      OR (o.number_value=o.previous_value OR o.number_value IS NULL AND o.previous_missing) AND o.code<o.previous_code),
    'catalog pages follow the primary specification value, then code, with missing values last');
  PERFORM pg_temp.assert_true((SELECT max(position) FROM seen_catalog WHERE code LIKE 'TEST-P%')
      <(SELECT min(position) FROM seen_catalog WHERE code IN ('TEST-R','TEST-C')),
    'listed categories come before uncategorised products');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'[["A","x"],["A",null]]')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'{"A":"x"}')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'[["A",1]]')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'"A"')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'["A"]')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.expect_error($q$SELECT public.amp_catalog(p_sort=>'[["A"]]')$q$,'INVALID_CATALOG_QUERY');
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.amp_catalog('TEST-P1103','ZZZZ',1)),
    'exact product lookup is independent of cursor and first-page position');
  PERFORM pg_temp.assert_true((SELECT count(*)=200 FROM public.amp_catalog()),'default catalog page is bounded');
  PERFORM pg_temp.expect_error('SELECT public.amp_catalog(NULL,NULL,0)','INVALID_CATALOG_PAGE_SIZE');
  PERFORM pg_temp.expect_error('SELECT public.amp_catalog(NULL,NULL,201)','INVALID_CATALOG_PAGE_SIZE');
  PERFORM pg_temp.expect_error('SELECT public.amp_catalog(NULL,NULL,NULL)','INVALID_CATALOG_PAGE_SIZE');
END $$;
-- Topology is independent of product presence and publication status.
INSERT INTO app.cabinets(code,outer_row,outer_col,inner_rows,inner_cols)
VALUES('TEST-EMPTY-CAB',1,2,2,2);
INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col) VALUES
 ('75000000-0000-4000-8000-000000000002','TEST-EMPTY-BIN','74000000-0000-4000-8000-000000000001',1,2),
 ('75000000-0000-4000-8000-000000000003','TEST-INACTIVE-BIN','74000000-0000-4000-8000-000000000001',1,3);
INSERT INTO app.products(code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok)
VALUES('TEST-INACTIVE','Inaktiv del','Inactive product','75000000-0000-4000-8000-000000000003','pcs',1,1,0);
SET LOCAL ROLE anon;
DO $$
DECLARE j jsonb := public.amp_shelf_map();
BEGIN
  PERFORM pg_temp.assert_true(jsonb_array_length(j->'cabinets')=2 AND jsonb_array_length(j->'bins')=3,
    'public topology includes empty cabinets, empty bins and inactive-only bins');
  PERFORM pg_temp.assert_true((SELECT b->'has_products'='true'::jsonb FROM jsonb_array_elements(j->'bins') b WHERE b->>'code'='TEST-INACTIVE-BIN')
    AND (SELECT b->'has_products'='false'::jsonb FROM jsonb_array_elements(j->'bins') b WHERE b->>'code'='TEST-EMPTY-BIN'),
    'public topology exposes only a boolean for assigned contents, including inactive products');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM jsonb_array_elements(j->'cabinets') c
    WHERE c->>'code'='TEST-EMPTY-CAB' AND c->>'inner_rows'='2' AND c->>'inner_cols'='2'),
    'empty cabinet dimensions establish genuine free cells');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'bins') b
    WHERE b ?| ARRAY['product_name','quantity','purchase_url','created_by']),
    'public topology exposes physical placement without internal product or staff data');
END $$;
RESET ROLE;
UPDATE app.bins SET is_archived=true WHERE code='TEST-EMPTY-BIN';
UPDATE app.cabinets SET is_archived=true WHERE code='TEST-EMPTY-CAB';
SELECT pg_temp.assert_true(jsonb_array_length(public.amp_shelf_map()->'cabinets')=1
  AND jsonb_array_length(public.amp_shelf_map()->'bins')=2,'archived storage is absent from the current public map');
ROLLBACK;
