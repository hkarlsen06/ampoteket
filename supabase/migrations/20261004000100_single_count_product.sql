-- A single-product count made its own batch titled 'Single count <code>', an
-- English sentence the Norwegian staff pages displayed verbatim. Record which
-- product such a batch belongs to and keep only the language-neutral product
-- code as its title; the pages render the localized wording from product_id.
ALTER TABLE app.count_batches
  ADD COLUMN product_id uuid REFERENCES app.products(id),
  ADD CONSTRAINT count_batches_single_count_finished CHECK (product_id IS NULL OR finished_at IS NOT NULL);

UPDATE app.count_batches b SET product_id=s.product_id,title=p.code
  FROM app.command_requests r,app.stock_counts s,app.products p
  WHERE r.id=b.request_id AND r.command_name='record_single_count'
    AND s.batch_id=b.id AND p.id=s.product_id;

-- Same signature and grants: only the batch it creates changes.
CREATE OR REPLACE FUNCTION public.amp_record_single_count(
  p_request_id uuid,p_product_id uuid,
  p_expected_revision bigint,p_counted_quantity numeric,p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
  v_quantity numeric; v_revision bigint; v_event uuid; v_delta numeric;
  v_batch uuid; v_code text; v_now timestamptz;
BEGIN
  v_cached := app.begin_command(p_request_id,'record_single_count',v_actor,
    jsonb_build_object('product',p_product_id,'revision',p_expected_revision,
      'counted',p_counted_quantity,'note',p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.lock_products(ARRAY[p_product_id]);
  PERFORM app.validate_quantity(p_product_id,p_counted_quantity,false,true);
  IF p_counted_quantity<0 THEN RAISE EXCEPTION 'NEGATIVE_PHYSICAL_COUNT'; END IF;
  SELECT quantity,revision INTO STRICT v_quantity,v_revision FROM app.inventory WHERE product_id=p_product_id;
  IF p_expected_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'STALE_STOCK_COUNT'; END IF;
  SELECT code INTO STRICT v_code FROM app.products WHERE id=p_product_id;
  v_now := clock_timestamp();
  INSERT INTO app.count_batches(request_id,owner_id,title,product_id,started_at,finished_at,finished_by)
    VALUES(p_request_id,v_actor,v_code,p_product_id,v_now,v_now,v_actor) RETURNING id INTO v_batch;
  INSERT INTO app.inventory_events(request_id,kind,actor_id,note)
    VALUES(p_request_id,'count',v_actor,p_note) RETURNING id INTO v_event;
  INSERT INTO app.stock_counts(event_id,batch_id,product_id,expected_quantity,counted_quantity,expected_revision)
    VALUES(v_event,v_batch,p_product_id,v_quantity,p_counted_quantity,v_revision);
  v_delta := p_counted_quantity-v_quantity;
  IF v_delta <> 0 THEN
    INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta) VALUES(v_event,p_product_id,v_delta);
  END IF;
  RETURN app.finish_command(p_request_id,
    jsonb_build_object('batch_id',v_batch,'event_id',v_event,
      'quantity',p_counted_quantity::text,'difference',v_delta::text));
END $$;

-- The view lists columns as of its creation; expose the new one to staff.
CREATE OR REPLACE VIEW public.amp_count_batches WITH (security_invoker=true) AS SELECT * FROM app.count_batches;

NOTIFY pgrst,'reload schema';
