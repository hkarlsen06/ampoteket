-- Included by acceptance.sql: helpers and fixtures already exist, all rolled back.
DO $$
DECLARE
  cab jsonb := jsonb_build_object('id',gen_random_uuid(),'code','LAYOUT-CABINET','label',NULL,
    'outer_row',30,'outer_col',30,'inner_rows',12,'inner_cols',4,'is_archived',false);
  original_bins jsonb; v_bins jsonb; merged jsonb; changed jsonb; smaller jsonb; wider jsonb;
  req uuid := gen_random_uuid(); product_id uuid := gen_random_uuid(); first_id uuid; edge_id uuid;
  reply jsonb; retry jsonb; audit_count bigint; malformed jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'code','LAYOUT-'||r||'-'||c,
    'label',NULL,'cabinet_id',cab->>'id','inner_row',r,'inner_col',c,'row_span',1,'col_span',1,
    'is_archived',false) ORDER BY r,c) INTO v_bins
    FROM generate_series(1,12) r CROSS JOIN generate_series(1,4) c;
  original_bins := v_bins;
  reply := public.amp_save_shelf_layout(req,NULL,cab,'[]',v_bins);
  SELECT count(*) INTO audit_count FROM app.audit_log;
  retry := public.amp_save_shelf_layout(req,NULL,cab,'[]',v_bins);
  PERFORM pg_temp.assert_true(reply=retry AND reply=jsonb_build_object('cabinet_id',cab->>'id','saved',true)
    AND (SELECT count(*)=48 FROM app.bins WHERE cabinet_id=(cab->>'id')::uuid)
    AND (SELECT count(*)=audit_count FROM app.audit_log),'layout creates 48 stable drawers atomically and retry adds no audit');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,NULL,%L,%L,%L)',
    req,cab||'{"label":"changed"}', '[]',v_bins),'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');

  first_id := (v_bins->0->>'id')::uuid;
  edge_id := (v_bins->47->>'id')::uuid;
  INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
    VALUES(product_id,'LAYOUT-PRODUCT','Skuffetest','Drawer test',first_id,'pcs',1,1,1,false);
  changed := cab||'{"label":"Preserve identities"}';
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),cab,changed,v_bins,v_bins);
  PERFORM pg_temp.assert_true((SELECT bin_id=first_id FROM app.products WHERE id=product_id)
    AND (SELECT count(*)=48 FROM app.bins WHERE cabinet_id=(cab->>'id')::uuid),'layout metadata preserves drawer identities and inactive assignments');
  cab := changed;
  SELECT jsonb_agg(value) INTO merged FROM jsonb_array_elements(v_bins)
    WHERE value->>'id'<>first_id::text;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,v_bins,merged),'LAYOUT_HAS_PRODUCTS');
  SELECT jsonb_agg(CASE WHEN value->>'id'=first_id::text THEN value||'{"col_span":2}' ELSE value END)
    INTO merged FROM jsonb_array_elements(v_bins) WHERE value->>'id'<>v_bins->1->>'id';
  PERFORM pg_temp.expect_error(format('UPDATE app.bins SET col_span=2,inner_row=2 WHERE id=%L',first_id),'LAYOUT_HAS_PRODUCTS');
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),cab,cab,v_bins,merged);
  PERFORM pg_temp.assert_true((SELECT col_span=2 AND NOT is_archived FROM app.bins WHERE id=first_id)
    AND (SELECT is_archived AND cabinet_id IS NULL FROM app.bins WHERE id=(v_bins->1->>'id')::uuid)
    AND (SELECT bin_id=first_id FROM app.products WHERE id=product_id),
    'occupied drawer grows over a whole empty neighbour while preserving identity and contents');
  v_bins := merged;
  PERFORM pg_temp.expect_error(format('UPDATE app.bins SET col_span=1 WHERE id=%L',first_id),'LAYOUT_HAS_PRODUCTS');
  SELECT jsonb_agg(CASE WHEN value->>'id'=first_id::text THEN value||'{"col_span":1}' ELSE value END)
    INTO merged FROM jsonb_array_elements(v_bins);
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,v_bins,merged),'LAYOUT_HAS_PRODUCTS');

  UPDATE app.products SET bin_id=edge_id WHERE id=product_id;
  smaller := cab||'{"inner_rows":11}';
  SELECT jsonb_agg(value) INTO merged FROM jsonb_array_elements(v_bins) WHERE (value->>'inner_row')::int<=11;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,smaller,v_bins,merged),'LAYOUT_HAS_PRODUCTS');
  UPDATE app.products SET bin_id=NULL WHERE id=product_id;
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),cab,smaller,v_bins,merged);
  PERFORM pg_temp.assert_true((SELECT inner_rows=11 FROM app.cabinets WHERE id=(cab->>'id')::uuid)
    AND (SELECT count(*)=43 FROM app.bins WHERE cabinet_id=(cab->>'id')::uuid),'shrinking empty layout removes drawers and updates dimensions together');
  cab := smaller; v_bins := merged;

  -- A simultaneous grow in one axis and shrink in the other must satisfy all
  -- ordinary placement constraints at each internal statement boundary.
  wider := cab||'{"inner_rows":10,"inner_cols":5}';
  SELECT jsonb_agg(value) INTO merged FROM jsonb_array_elements(v_bins) WHERE (value->>'inner_row')::int<=10;
  SELECT merged||jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'code','LAYOUT-WIDE-'||r,
    'label',NULL,'cabinet_id',cab->>'id','inner_row',r,'inner_col',5,'row_span',1,'col_span',1,
    'is_archived',false)) INTO merged FROM generate_series(1,10) r;
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),cab,wider,v_bins,merged);
  PERFORM pg_temp.assert_true((SELECT inner_rows=10 AND inner_cols=5 FROM app.cabinets WHERE id=(cab->>'id')::uuid)
    AND (SELECT count(*)=49 FROM app.bins WHERE cabinet_id=(cab->>'id')::uuid),'layout grows and shrinks different axes without partial geometry');
  cab := wider; v_bins := merged;

  -- Original full snapshots, not just the cabinet dimensions, guard a save.
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,original_bins,v_bins),'STALE_SHELF_LAYOUT');
  FOR malformed IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    cab||'{"unexpected":true}',cab||'{"inner_rows":"10"}',cab||'{"inner_rows":1.5}',
    cab||'{"inner_rows":0}',cab||'{"inner_rows":4097}',cab||'{"id":false}',cab||'{"is_archived":null}')) LOOP
    PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
      gen_random_uuid(),cab,malformed,v_bins,v_bins),'INVALID_SHELF_LAYOUT');
  END LOOP;
  FOR malformed IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    v_bins||jsonb_build_array(v_bins->0),
    jsonb_set(v_bins,'{0,col_span}','1.5'),jsonb_set(v_bins,'{0,inner_row}','"1"'),
    jsonb_set(v_bins,'{0,is_archived}','true'),jsonb_set(v_bins,'{0,cabinet_id}',to_jsonb(gen_random_uuid())),
    jsonb_set(v_bins,'{0,code}','"REPLACED-STABLE-CODE"'),
    jsonb_set(v_bins,'{0,id}','"75000000-0000-4000-8000-000000000001"'),
    jsonb_set(v_bins,'{0,col_span}','5'))) LOOP
    PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
      gen_random_uuid(),cab,cab,v_bins,malformed),'INVALID_SHELF_LAYOUT');
  END LOOP;
  req := gen_random_uuid();
  UPDATE app.bins SET label='Concurrent placement edit' WHERE id=first_id;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    req,cab,cab,v_bins,v_bins),'STALE_SHELF_LAYOUT');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM app.command_requests WHERE id=req),
    'stale layout leaves no successful command receipt');
END $$;

-- One confirmed cabinet retirement archives every unassigned drawer while
-- preserving archive-time addresses, including after later cabinet moves.
DO $$
DECLARE
  cab jsonb := jsonb_build_object('id',gen_random_uuid(),'code','RETIRE-CABINET','label','Retirement test',
    'outer_row',50,'outer_col',50,'inner_rows',2,'inner_cols',2,'is_archived',false);
  bins jsonb; before_bins jsonb; before_cab jsonb;
  first_id uuid; second_id uuid; product_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid(); reply jsonb; audit_count bigint;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'code','RETIRE-'||r||'-'||c,
    'label',NULL,'cabinet_id',cab->>'id','inner_row',r,'inner_col',c,'row_span',1,'col_span',1,
    'is_archived',false) ORDER BY r,c) INTO bins
    FROM generate_series(1,2) r CROSS JOIN generate_series(1,2) c;
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),NULL,cab,'[]',bins);
  first_id := (bins->0->>'id')::uuid;
  second_id := (bins->1->>'id')::uuid;
  UPDATE app.bins SET is_archived=true WHERE id=first_id;
  UPDATE app.cabinets SET outer_col=51 WHERE id=(cab->>'id')::uuid;
  PERFORM pg_temp.assert_true((SELECT cabinet_outer_row=50 AND cabinet_outer_col=50
    AND inner_row=1 AND inner_col=1 FROM public.amp_archived_bin_locations WHERE bin_id=first_id),
    'archived drawer reports cabinet position from its archive time, before a later move');

  INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
    VALUES(product_id,'RETIRE-PRODUCT','Arkivtest','Archive test',second_id,'pcs',1,1,0,false);
  SELECT to_jsonb(c) INTO before_cab FROM app.cabinets c WHERE c.id=(cab->>'id')::uuid;
  SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) INTO before_bins FROM app.bins b
    WHERE b.cabinet_id=(cab->>'id')::uuid AND NOT b.is_archived;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_archive_empty_cabinet(%L,%L::jsonb,%L::jsonb)',
    request_id,before_cab,before_bins),'BIN_STILL_HAS_PRODUCTS');
  PERFORM pg_temp.assert_true((SELECT count(*)=3 FROM app.bins WHERE cabinet_id=(cab->>'id')::uuid)
    AND (SELECT NOT is_archived FROM app.cabinets WHERE id=(cab->>'id')::uuid)
    AND NOT EXISTS(SELECT 1 FROM app.command_requests WHERE id=request_id),
    'occupied drawer rejects whole retirement without partial changes or command receipt');
  UPDATE app.products SET bin_id=NULL WHERE id=product_id;
  UPDATE app.bins SET label='Edited meanwhile' WHERE id=second_id;
  PERFORM pg_temp.expect_error(format('SELECT public.amp_archive_empty_cabinet(%L,%L::jsonb,%L::jsonb)',
    request_id,before_cab,before_bins),'STALE_SHELF_LAYOUT');
  SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) INTO before_bins FROM app.bins b
    WHERE b.cabinet_id=(cab->>'id')::uuid AND NOT b.is_archived;
  SELECT count(*) INTO audit_count FROM app.audit_log;
  reply := public.amp_archive_empty_cabinet(request_id,before_cab,before_bins);
  PERFORM pg_temp.assert_true(reply=jsonb_build_object('cabinet_id',cab->>'id','archived_bins',3)
    AND (SELECT count(*)=audit_count+4 FROM app.audit_log)
    AND (SELECT is_archived AND outer_row IS NULL AND outer_col IS NULL FROM app.cabinets WHERE id=(cab->>'id')::uuid)
    AND (SELECT count(*)=4 FROM app.bins WHERE is_archived AND code LIKE 'RETIRE-%'),
    'one command archives cabinet and all remaining empty drawers with four audit images');
  audit_count := (SELECT count(*) FROM app.audit_log);
  PERFORM pg_temp.assert_true(reply=public.amp_archive_empty_cabinet(request_id,before_cab,before_bins)
    AND (SELECT count(*)=audit_count FROM app.audit_log),'retirement retry returns saved result without extra audit');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_archive_empty_cabinet(%L,%L::jsonb,%L::jsonb)',
    request_id,before_cab,'[]'),'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
  PERFORM pg_temp.assert_true((SELECT count(*)=3 FROM public.amp_archived_bin_locations
    WHERE cabinet_id=(cab->>'id')::uuid AND cabinet_outer_row=50 AND cabinet_outer_col=51)
    AND (SELECT count(*)=1 FROM public.amp_archived_bin_locations
      WHERE cabinet_id=(cab->>'id')::uuid AND cabinet_outer_row=50 AND cabinet_outer_col=50),
    'archive projection keeps distinct before-and-after cabinet positions');
END $$;

SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.assert_true((SELECT count(*)=4 FROM public.amp_archived_bin_locations
    WHERE cabinet_code='RETIRE-CABINET'),
    'authenticated staff can read former drawer locations through the invoker view');
END $$;
RESET ROLE;


-- Growing an occupied drawer consumes whole unassigned neighbours only.
DO $$
DECLARE
  cab jsonb := jsonb_build_object('id',gen_random_uuid(),'code','EXPAND-CABINET','label',NULL,
    'outer_row',31,'outer_col',30,'inner_rows',2,'inner_cols',4,'is_archived',false);
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); p uuid := gen_random_uuid(); q uuid := gen_random_uuid();
  v_bins jsonb; partial jsonb; expanded jsonb;
BEGIN
  v_bins := jsonb_build_array(
    jsonb_build_object('id',a,'code','EXPAND-A','label',NULL,'cabinet_id',cab->>'id',
      'inner_row',1,'inner_col',1,'row_span',1,'col_span',1,'is_archived',false),
    jsonb_build_object('id',b,'code','EXPAND-B','label',NULL,'cabinet_id',cab->>'id',
      'inner_row',1,'inner_col',2,'row_span',1,'col_span',2,'is_archived',false));
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),NULL,cab,'[]',v_bins);
  INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok)
    VALUES(p,'EXPAND-P','Utvidelse','Expansion',a,'pcs',1,1,0),(q,'EXPAND-Q','Nabo','Neighbour',b,'pcs',1,1,0);
  expanded := jsonb_build_array(v_bins->0||'{"col_span":3}');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,v_bins,expanded),'LAYOUT_HAS_PRODUCTS');
  UPDATE app.products SET bin_id=NULL WHERE id=q;
  partial := jsonb_build_array(v_bins->0||'{"col_span":2}',v_bins->1||'{"inner_col":3,"col_span":1}');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,v_bins,partial),'INVALID_SHELF_LAYOUT');
  partial := jsonb_build_array(v_bins->0||'{"col_span":2}');
  PERFORM pg_temp.expect_error(format('SELECT public.amp_save_shelf_layout(%L,%L,%L,%L,%L)',
    gen_random_uuid(),cab,cab,v_bins,partial),'INVALID_SHELF_LAYOUT');
  PERFORM public.amp_save_shelf_layout(gen_random_uuid(),cab,cab,v_bins,expanded);
  PERFORM pg_temp.assert_true((SELECT bin_id=a FROM app.products WHERE id=p)
    AND (SELECT is_archived FROM app.bins WHERE id=b),'occupied expansion consumes the complete empty neighbour');
  -- Direct expansion into vacant cells is also safe at the same anchor.
  UPDATE app.bins SET col_span=4 WHERE id=a;
  PERFORM pg_temp.assert_true((SELECT col_span=4 FROM app.bins WHERE id=a)
    AND (SELECT bin_id=a FROM app.products WHERE id=p),'direct same-anchor growth retains assigned products');
  PERFORM pg_temp.expect_error(format('UPDATE app.bins SET row_span=2,col_span=3 WHERE id=%L',a),'LAYOUT_HAS_PRODUCTS');
  PERFORM pg_temp.expect_error(format('UPDATE app.bins SET inner_row=2,col_span=3 WHERE id=%L',a),'LAYOUT_HAS_PRODUCTS');
END $$;
