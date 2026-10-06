-- Borrow-only products, such as breadboards: listed with recorded stock, never
-- sold. A product without a sale price is borrow-only; only staff change its stock.
ALTER TABLE app.products ALTER COLUMN sale_unit_price_nok DROP NOT NULL;

-- Unchanged except that a borrow-only product is not for sale. CREATE OR REPLACE
-- keeps the reviewed grants (service_role only).
CREATE OR REPLACE FUNCTION public.amp_prepare_checkout(
  p_request_id uuid,p_token text,p_items jsonb,p_contact_text text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cached jsonb; v_id uuid; r record; p app.products%ROWTYPE; v_quantity app.quantity;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_CHECKOUT_TOKEN'; END IF;
  v_cached := app.begin_command(p_request_id,'prepare_checkout',NULL,
    jsonb_build_object('token_digest',encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      'items',p_items,'contact',p_contact_text));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.check_items(p_items);
  IF (SELECT count(*)<>count(DISTINCT item.value->>'product_id') FROM jsonb_array_elements(p_items) AS item(value))
    THEN RAISE EXCEPTION 'DUPLICATE_OR_MISSING_CART_PRODUCT'; END IF;
  PERFORM app.lock_products(ARRAY(SELECT (item.value->>'product_id')::uuid FROM jsonb_array_elements(p_items) AS item(value)));
  INSERT INTO app.checkouts(request_id,token_digest)
    VALUES(p_request_id,sha256(convert_to(p_token,'UTF8'))) RETURNING id INTO v_id;
  FOR r IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO STRICT p FROM app.products WHERE id=(r.value->>'product_id')::uuid;
    IF NOT p.is_active OR p.sale_unit_price_nok IS NULL THEN RAISE EXCEPTION 'PRODUCT_NOT_FOR_SALE'; END IF;
    v_quantity := (r.value->>'quantity')::numeric;
    PERFORM app.validate_quantity(p.id,v_quantity,true);
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'POSITIVE_CART_QUANTITY_REQUIRED'; END IF;
    INSERT INTO app.checkout_lines(checkout_id,product_id,product_name_nb_snapshot,product_name_en_snapshot,quantity,unit_price_nok)
      VALUES(v_id,p.id,p.name_nb,p.name_en,v_quantity,p.sale_unit_price_nok);
  END LOOP;
  IF nullif(btrim(p_contact_text),'') IS NOT NULL THEN
    INSERT INTO app.checkout_contacts VALUES(v_id,btrim(p_contact_text));
  END IF;
  RETURN app.finish_command(p_request_id,jsonb_build_object('checkout_id',v_id));
END $$;
