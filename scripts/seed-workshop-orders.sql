-- Fictional year of activity for the owned, disposable workshop seed.
-- Historical recorded_at values require direct fixture inserts: normal RPCs
-- use the current clock and checkout/inventory history is immutable.
BEGIN;
DO $$
DECLARE
  v_start timestamptz := date_trunc('day', now() - interval '1 year');
  v_at timestamptz;
  v_actor uuid := 'de000002-0000-4000-8000-000000000001';
  v_order uuid;
  v_line uuid;
  v_event uuid;
  v_checkout uuid;
  v_request uuid;
  v_product app.products%ROWTYPE;
  v_quantity numeric;
  v_ordered numeric;
  v_movement bigint;
  v_stock app.inventory%ROWTYPE;
  v_batch uuid;
  v_used uuid[];
  n integer;
  line_no integer;
BEGIN
  IF current_setting('ampoteket.test_seed',true) IS DISTINCT FROM 'disposable-only'
    OR NOT EXISTS (SELECT 1 FROM app.staff_members WHERE id=v_actor
    AND display_name='Synthetic seed fixture (no login)')
    OR NOT EXISTS (SELECT 1 FROM auth.users WHERE email='test@test.no') THEN
    RAISE EXCEPTION 'WORKSHOP_HISTORY_REQUIRES_DISPOSABLE_SEED';
  END IF;
  IF EXISTS (SELECT 1 FROM app.purchase_orders WHERE supplier_reference='DEMO-YEAR-001') THEN RETURN; END IF;

  -- Only this fresh disposable fixture backdates its opening records. The
  -- immutable-row trigger is restored in the same transaction.
  EXECUTE 'ALTER TABLE app.inventory_events DISABLE TRIGGER immutable_rows';
  UPDATE app.inventory_events SET occurred_at=v_start-interval '1 day',
    recorded_at=v_start-interval '1 day'
    WHERE actor_id=v_actor AND kind IN ('adjustment','count');
  EXECUTE 'ALTER TABLE app.inventory_events ENABLE TRIGGER immutable_rows';
  UPDATE app.count_batches SET started_at=v_start-interval '1 day',
    finished_at=v_start-interval '1 day'
    WHERE owner_id=v_actor;
  UPDATE app.command_requests SET created_at=v_start-interval '1 day'
    WHERE actor_id=v_actor AND command_name IN ('adjustment','record_single_count');

  FOR n IN 1..24 LOOP
    v_at := v_start + n * interval '15 days' + interval '10 hours';
    v_order := gen_random_uuid();
    v_request := gen_random_uuid();
    INSERT INTO app.command_requests(id,command_name,actor_id,request_digest,result,created_at)
      VALUES(v_request,'record_order',v_actor,sha256(convert_to('demo order '||n,'UTF8')),
        jsonb_build_object('order_id',v_order),v_at);
    INSERT INTO app.purchase_orders(id,request_id,supplier_name,supplier_reference,placed_at,
      additional_cost_nok,note,created_by,recorded_at)
      VALUES(v_order,v_request,(ARRAY['DEMO Elfa Distrelec','DEMO Mouser Electronics',
        'DEMO DigiKey','DEMO Kjell & Company'])[1+(n%4)],
        'DEMO-YEAR-'||lpad(n::text,3,'0'),v_at,CASE WHEN n%4=0 THEN 89 ELSE 49 END,
        'Fictional local development purchase; no external order was placed.',v_actor,v_at);
    v_used := ARRAY[]::uuid[];
    IF n <= 22 THEN
      v_event := gen_random_uuid();
      INSERT INTO app.inventory_events(id,kind,actor_id,purchase_order_id,note,occurred_at,recorded_at)
        VALUES(v_event,'receipt',v_actor,v_order,'Fictional supplier delivery',
          v_at+interval '8 days',v_at+interval '8 days');
    END IF;
    FOR line_no IN 1..2 LOOP
      SELECT p.* INTO STRICT v_product FROM app.products p
        WHERE p.id <> ALL(v_used)
        ORDER BY md5(p.id::text||'order'||n||'line'||line_no) LIMIT 1;
      v_used := array_append(v_used,v_product.id);
      v_ordered := CASE v_product.unit_code WHEN 'g' THEN 500 WHEN 'm' THEN 10
        ELSE 12 + (n%5)*4 END;
      v_line := gen_random_uuid();
      INSERT INTO app.purchase_order_lines(id,order_id,line_number,product_id,ordered_quantity,
        unit_cost_nok,supplier_sku)
        VALUES(v_line,v_order,line_no,v_product.id,v_ordered,
          round(v_product.sale_unit_price_nok * 0.55,2),'DEMO-'||v_product.code);
      IF n <= 22 THEN
        v_quantity := CASE WHEN n>19 OR (n%5=0 AND line_no=2)
          THEN round(v_ordered/2, 6) ELSE v_ordered END;
        INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
          VALUES(v_event,v_product.id,v_quantity) RETURNING id INTO v_movement;
        INSERT INTO app.receipt_allocations(movement_id,order_line_id) VALUES(v_movement,v_line);
      END IF;
    END LOOP;
  END LOOP;

  -- Roughly three small self-service purchases per week. A registered sale
  -- remains a buyer's claim, never evidence of verified Vipps payment.
  FOR n IN 1..156 LOOP
    v_at := v_start + n * interval '2.3 days' + interval '14 hours';
    v_checkout := gen_random_uuid();
    v_request := gen_random_uuid();
    INSERT INTO app.command_requests(id,command_name,request_digest,result,created_at)
      VALUES(v_request,'prepare_checkout',sha256(convert_to('demo checkout '||n,'UTF8')),
        jsonb_build_object('checkout_id',v_checkout),v_at);
    INSERT INTO app.checkouts(id,request_id,token_digest,created_at)
      VALUES(v_checkout,v_request,sha256(convert_to('fictional checkout token '||n,'UTF8')),v_at);
    v_event := gen_random_uuid();
    INSERT INTO app.inventory_events(id,kind,occurred_at,recorded_at)
      VALUES(v_event,'sale',v_at+interval '5 minutes',v_at+interval '5 minutes');
    v_used := ARRAY[]::uuid[];
    FOR line_no IN 1..(1+n%3) LOOP
      SELECT p.* INTO STRICT v_product FROM app.products p JOIN app.inventory i ON i.product_id=p.id
        WHERE p.id <> ALL(v_used) AND i.quantity >= CASE p.unit_code
          WHEN 'g' THEN 25 WHEN 'm' THEN 0.5 ELSE 1+n%3 END
        ORDER BY md5(p.id::text||'sale'||n||'line'||line_no) LIMIT 1;
      v_used := array_append(v_used,v_product.id);
      v_quantity := CASE v_product.unit_code WHEN 'g' THEN 25 WHEN 'm' THEN 0.5
        ELSE 1+n%3 END;
      INSERT INTO app.checkout_lines(checkout_id,product_id,product_name_nb_snapshot,
        product_name_en_snapshot,quantity,unit_price_nok)
        VALUES(v_checkout,v_product.id,v_product.name_nb,v_product.name_en,
          v_quantity,v_product.sale_unit_price_nok);
      INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
        VALUES(v_event,v_product.id,-v_quantity);
    END LOOP;
    INSERT INTO app.sales(checkout_id,event_id) VALUES(v_checkout,v_event);
  END LOOP;

  -- Prepared checkouts do not withdraw stock.
  FOR n IN 1..3 LOOP
    v_at := now() - n * interval '2 days';
    v_checkout := gen_random_uuid();
    v_request := gen_random_uuid();
    SELECT * INTO STRICT v_product FROM app.products ORDER BY id OFFSET 110+n LIMIT 1;
    INSERT INTO app.command_requests(id,command_name,request_digest,result,created_at)
      VALUES(v_request,'prepare_checkout',sha256(convert_to('demo open checkout '||n,'UTF8')),
        jsonb_build_object('checkout_id',v_checkout),v_at);
    INSERT INTO app.checkouts(id,request_id,token_digest,created_at)
      VALUES(v_checkout,v_request,sha256(convert_to('fictional open token '||n,'UTF8')),v_at);
    INSERT INTO app.checkout_lines(checkout_id,product_id,product_name_nb_snapshot,
      product_name_en_snapshot,quantity,unit_price_nok)
      VALUES(v_checkout,v_product.id,v_product.name_nb,v_product.name_en,
        v_product.sale_step,v_product.sale_unit_price_nok);
  END LOOP;

  -- Recent zero-difference spot counts are still useful stocktake history.
  FOR n IN 1..4 LOOP
    SELECT i.* INTO STRICT v_stock FROM app.inventory i
      JOIN app.products p ON p.id=i.product_id ORDER BY p.id OFFSET 120+n LIMIT 1;
    v_at := now() - n * interval '1 day';
    v_request := gen_random_uuid();
    v_batch := gen_random_uuid();
    v_event := gen_random_uuid();
    INSERT INTO app.command_requests(id,command_name,actor_id,request_digest,result,created_at)
      VALUES(v_request,'record_single_count',v_actor,sha256(convert_to('demo count '||n,'UTF8')),
        jsonb_build_object('batch_id',v_batch,'event_id',v_event,'quantity',v_stock.quantity::text,'difference','0'),v_at);
    INSERT INTO app.count_batches(id,request_id,owner_id,title,started_at,finished_at,finished_by)
      VALUES(v_batch,v_request,v_actor,'DEMO spot count '||n,v_at,v_at,v_actor);
    INSERT INTO app.inventory_events(id,request_id,kind,actor_id,note,occurred_at,recorded_at)
      VALUES(v_event,v_request,'count',v_actor,'Fictional spot count; no difference',v_at,v_at);
    INSERT INTO app.stock_counts(event_id,batch_id,product_id,expected_quantity,counted_quantity,expected_revision)
      VALUES(v_event,v_batch,v_stock.product_id,v_stock.quantity,v_stock.quantity,v_stock.revision);
  END LOOP;
END $$;
COMMIT;
