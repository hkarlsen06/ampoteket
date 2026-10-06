-- Search also matches measurements typed without the space ("10k", "10kΩ",
-- "100n" find "10 kΩ" and "100 nF"). The searched text gains a copy with
-- whitespace removed between a digit and a following letter; src/lib/catalog-search.ts
-- mirrors this exactly. CREATE OR REPLACE keeps the function's revoked ACL.
CREATE OR REPLACE FUNCTION app.catalog_matches(p_product app.products,p_category text,p_q text,p_conditions jsonb,p_labels jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_search text; a record; v_alias jsonb; v_condition jsonb;
BEGIN
  IF p_q<>'' THEN
    v_search := concat_ws(' ',p_product.code,replace(p_product.code,'-',''),p_product.name_nb,p_product.name_en,p_product.description,p_category,
      app.catalog_name_measurements(p_product.name_nb,'nb',coalesce(p_labels->'units','{}')),
      app.catalog_name_measurements(p_product.name_en,'en',coalesce(p_labels->'units','{}')),
      p_labels->'categories'->>lower(btrim(p_category)));
  END IF;
  FOR a IN SELECT d.code,d.label,d.value_type,d.canonical_unit,p.number_value,p.text_value,p.boolean_value
    FROM app.product_attributes p JOIN app.attribute_definitions d ON d.id=p.attribute_id WHERE p.product_id=p_product.id LOOP
    v_condition := p_conditions->a.code;
    IF v_condition IS NOT NULL THEN
      IF a.value_type='number' THEN
        IF (v_condition ? 'eq' AND a.number_value<>(v_condition->>'eq')::numeric)
          OR (v_condition ? 'min' AND a.number_value<(v_condition->>'min')::numeric)
          OR (v_condition ? 'max' AND a.number_value>(v_condition->>'max')::numeric) THEN RETURN false; END IF;
      ELSIF coalesce(a.text_value,a.boolean_value::text) IS DISTINCT FROM v_condition->>'eq' THEN RETURN false;
      END IF;
    END IF;
    IF p_q<>'' THEN
      v_alias := p_labels->'attributes'->a.code;
      v_search := concat_ws(' ',v_search,a.label,
        CASE WHEN v_alias->>'value_type'=a.value_type AND (v_alias->>'unit') IS NOT DISTINCT FROM a.canonical_unit THEN v_alias->>'labels' END,
        coalesce(a.number_value::text,a.text_value,CASE WHEN a.boolean_value THEN 'true yes ja' ELSE 'false no nei' END),a.canonical_unit,
        CASE WHEN a.value_type='number' THEN app.catalog_measurement(a.number_value,a.canonical_unit,'nb',coalesce(p_labels->'units','{}')) END,
        CASE WHEN a.value_type='number' THEN app.catalog_measurement(a.number_value,a.canonical_unit,'en',coalesce(p_labels->'units','{}')) END);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_conditions) AS keys(code) WHERE NOT EXISTS (
    SELECT 1 FROM app.product_attributes pa JOIN app.attribute_definitions d ON d.id=pa.attribute_id
    WHERE pa.product_id=p_product.id AND d.code=keys.code)) THEN RETURN false; END IF;
  IF p_q='' THEN RETURN true; END IF;
  v_search := app.catalog_fold(v_search);
  v_search := v_search||' '||regexp_replace(v_search COLLATE "und-x-icu",'([0-9])[[:space:]]+(?=[[:alpha:]ωμ])','\1','g');
  RETURN NOT EXISTS (SELECT 1 FROM regexp_split_to_table(app.catalog_fold(p_q),'[[:space:]]+') term WHERE term<>'' AND position(term IN v_search)=0);
END $$;
