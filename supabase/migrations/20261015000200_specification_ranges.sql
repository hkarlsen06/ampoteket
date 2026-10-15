-- A number specification may be a range, such as 250–400 V or 3–5,5 V:
-- number_value is the lower bound and number_max, when set, the upper one.
-- Existing rows stay single values. A dual rating (250 VAC and 400 VDC) is
-- two specifications instead; src/lib/product-specifications.ts adds
-- "AC voltage" (voltage_ac) for it, created on first use like the others.
ALTER TABLE app.product_attributes ADD COLUMN number_max numeric;
ALTER TABLE app.product_attributes ADD CONSTRAINT product_attributes_range_check
  CHECK (number_max IS NULL OR (number_value IS NOT NULL AND number_max > number_value AND number_max < 'Infinity'::numeric));
GRANT UPDATE (number_max) ON app.product_attributes TO authenticated;
-- The staff view was created as SELECT *, which fixes its column list.
CREATE OR REPLACE VIEW public.amp_product_attributes WITH (security_invoker=true) AS SELECT * FROM app.product_attributes;
GRANT UPDATE (number_max) ON public.amp_product_attributes TO authenticated;

-- A range is compared as its two bounds, so 250–400 V never equals 250 V.
CREATE OR REPLACE FUNCTION app.catalog_value_key(p_value app.product_attributes) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN p_value.number_max IS NOT NULL
      THEN jsonb_build_array(trim_scale(p_value.number_value)::text,trim_scale(p_value.number_max)::text)
    WHEN p_value.number_value IS NOT NULL THEN to_jsonb(trim_scale(p_value.number_value)::text)
    WHEN p_value.text_value<>'' THEN to_jsonb(p_value.text_value)
    WHEN p_value.boolean_value IS NOT NULL THEN to_jsonb(p_value.boolean_value) END
$$;

-- Search reads both bounds; a filter matches a range it overlaps.
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
  FOR a IN SELECT d.code,d.label,d.value_type,d.canonical_unit,p.number_value,p.number_max,p.text_value,p.boolean_value
    FROM app.product_attributes p JOIN app.attribute_definitions d ON d.id=p.attribute_id WHERE p.product_id=p_product.id LOOP
    v_condition := p_conditions->a.code;
    IF v_condition IS NOT NULL THEN
      IF a.value_type='number' THEN
        -- A range matches a condition it overlaps; a single value has number_max null.
        IF (v_condition ? 'eq' AND ((v_condition->>'eq')::numeric<a.number_value
              OR (v_condition->>'eq')::numeric>coalesce(a.number_max,a.number_value)))
          OR (v_condition ? 'min' AND coalesce(a.number_max,a.number_value)<(v_condition->>'min')::numeric)
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
        CASE WHEN a.value_type='number' THEN app.catalog_measurement(a.number_value,a.canonical_unit,'en',coalesce(p_labels->'units','{}')) END,
        a.number_max::text,
        CASE WHEN a.number_max IS NOT NULL THEN app.catalog_measurement(a.number_max,a.canonical_unit,'nb',coalesce(p_labels->'units','{}')) END,
        CASE WHEN a.number_max IS NOT NULL THEN app.catalog_measurement(a.number_max,a.canonical_unit,'en',coalesce(p_labels->'units','{}')) END);
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

-- Both bounds of a range are offered as filter values. CREATE OR REPLACE keeps
-- the reviewed grants.
CREATE OR REPLACE FUNCTION public.amp_catalog_facets(p_categories text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM app.check_catalog_query('',p_categories,'{}','{}');
  WITH attribute_values AS MATERIALIZED (
    SELECT p.code AS product_code,d.code,d.label,d.value_type,d.canonical_unit,
      a.number_value,a.number_max,a.text_value,a.boolean_value
    FROM app.products p JOIN app.product_attributes a ON a.product_id=p.id
    JOIN app.attribute_definitions d ON d.id=a.attribute_id LEFT JOIN app.categories c ON c.id=p.category_id
    WHERE p.is_active AND (cardinality(p_categories)=0 OR c.name=ANY(p_categories))
  ), definitions AS (SELECT DISTINCT ON (code) * FROM attribute_values ORDER BY code,product_code)
  SELECT jsonb_build_object('categories',(SELECT coalesce(jsonb_agg(name ORDER BY first_code),'[]') FROM (
      SELECT c.name,min(p.code) AS first_code FROM app.products p JOIN app.categories c ON c.id=p.category_id WHERE p.is_active GROUP BY c.name
    ) categories),
    'attributes',coalesce(jsonb_agg(jsonb_build_object('code',d.code,
      'definition',jsonb_build_object('label',d.label,'unit',d.canonical_unit,'value_type',d.value_type,
        'value',coalesce(to_jsonb(d.number_value::text),to_jsonb(d.text_value),to_jsonb(d.boolean_value)),
        'max',to_jsonb(d.number_max::text)),
      'values',CASE d.value_type
        WHEN 'number' THEN (SELECT jsonb_agg(trim_scale(n.value)::text ORDER BY n.value) FROM (
          SELECT DISTINCT bound.value FROM attribute_values v CROSS JOIN LATERAL (VALUES (v.number_value),(v.number_max)) bound(value)
          WHERE v.code=d.code AND bound.value IS NOT NULL) n)
        WHEN 'text' THEN (SELECT jsonb_agg(t.text_value ORDER BY t.first_code) FROM (SELECT v.text_value,min(v.product_code) first_code FROM attribute_values v WHERE v.code=d.code GROUP BY v.text_value) t)
        ELSE '[]'::jsonb END) ORDER BY d.product_code,d.code),'[]'::jsonb)) INTO v_result FROM definitions d;
  RETURN v_result;
END $$;

-- Each attribute carries `max`: the upper bound of a range, otherwise null.
CREATE OR REPLACE FUNCTION public.amp_catalog(p_code text DEFAULT NULL,p_after_code text DEFAULT NULL,
  p_limit integer DEFAULT 200,p_q text DEFAULT '',p_categories text[] DEFAULT '{}',
  p_conditions jsonb DEFAULT '{}',p_bin_id uuid DEFAULT NULL,p_labels jsonb DEFAULT '{}',
  p_cabinet_ids uuid[] DEFAULT '{}',p_bin_ids uuid[] DEFAULT '{}',p_sort jsonb DEFAULT '[]')
RETURNS TABLE (
  product_id uuid,code text,name_nb text,name_en text,description text,category_name text,
  unit_code text,unit_symbol text,sale_step text,sale_unit_price_nok text,
  quantity text,last_counted_at timestamptz,
  cabinet_code text,outer_row integer,outer_col integer,
  inner_rows integer,inner_cols integer,
  bin_code text,bin_label text,inner_row integer,inner_col integer,
  row_span integer,col_span integer,location_note text,
  datasheet_url text,attributes jsonb,distinguishing text[]
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_after app.catalog_sort_key;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'INVALID_CATALOG_PAGE_SIZE';
  END IF;
  PERFORM app.check_catalog_query(p_q,p_categories,p_conditions,p_labels);
  -- Array functions raise on other JSON types; OR has no evaluation order, CASE does.
  IF jsonb_typeof(p_sort) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_CATALOG_QUERY'; END IF;
  IF jsonb_array_length(p_sort)>100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_sort) e WHERE CASE
      WHEN jsonb_typeof(e)<>'array' THEN true WHEN jsonb_array_length(e) NOT IN (2,3) THEN true
      WHEN jsonb_array_length(e)=3 AND jsonb_typeof(e->2)<>'array' THEN true
      WHEN jsonb_array_length(e)=3 AND (jsonb_array_length(e->2)>100 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(e->2) c WHERE CASE WHEN jsonb_typeof(c)<>'string' THEN true
          ELSE c#>>'{}' !~ '^[a-z][a-z0-9_]{0,63}$' END)) THEN true
      ELSE jsonb_typeof(e->0)<>'string' OR length(e->>0) NOT BETWEEN 1 AND 100
        OR jsonb_typeof(e->1) NOT IN ('string','null') OR coalesce(length(e->>1),0)>64 END)
    OR jsonb_array_length(p_sort)<>(SELECT count(DISTINCT e->>0) FROM jsonb_array_elements(p_sort) e) THEN
    RAISE EXCEPTION 'INVALID_CATALOG_QUERY';
  END IF;
  IF p_cabinet_ids IS NULL OR p_bin_ids IS NULL
    OR cardinality(p_cabinet_ids)>100 OR cardinality(p_bin_ids)>4096
    OR cardinality(p_cabinet_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_cabinet_ids) id)
    OR cardinality(p_bin_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_bin_ids) id)
    OR EXISTS (SELECT 1 FROM unnest(p_cabinet_ids) selected(id) WHERE NOT EXISTS (
      SELECT 1 FROM app.cabinets c WHERE c.id=selected.id AND NOT c.is_archived))
    OR EXISTS (SELECT 1 FROM unnest(p_bin_ids) selected(id) WHERE NOT EXISTS (
      SELECT 1 FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id
      WHERE b.id=selected.id AND NOT b.is_archived AND NOT c.is_archived)) THEN
    RAISE EXCEPTION 'INVALID_CATALOG_FILTER';
  END IF;
  IF p_code IS NULL AND p_after_code IS NOT NULL THEN
    v_after := (SELECT app.catalog_sort_key(p,p_sort) FROM app.products p WHERE p.is_active AND p.code=p_after_code);
    IF v_after IS NULL THEN RAISE EXCEPTION 'CATALOG_CURSOR_MISSING'; END IF;
  END IF;
  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT p.*,app.catalog_sort_key(p,p_sort) AS sort_key FROM app.products p LEFT JOIN app.categories c ON c.id=p.category_id
    WHERE p.is_active AND (p_code IS NULL OR p.code=p_code)
      AND (p_bin_id IS NULL OR p.bin_id=p_bin_id)
      AND (cardinality(p_cabinet_ids)=0 AND cardinality(p_bin_ids)=0
        OR p.bin_id=ANY(p_bin_ids) OR EXISTS (
          SELECT 1 FROM app.bins b WHERE b.id=p.bin_id AND b.cabinet_id=ANY(p_cabinet_ids)))
      AND (cardinality(p_categories)=0 OR c.name=ANY(p_categories))
      AND (p_q='' AND p_conditions='{}'::jsonb OR app.catalog_matches(p,c.name,p_q,p_conditions,p_labels))
  ), page AS MATERIALIZED (
    SELECT * FROM selected s WHERE v_after IS NULL OR s.sort_key>v_after ORDER BY s.sort_key LIMIT p_limit
  ), variants AS MATERIALIZED (
    SELECT * FROM app.catalog_distinguishing(ARRAY(SELECT page.id FROM page),p_sort)
  )
  SELECT p.id,p.code,p.name_nb,p.name_en,p.description,c.name,p.unit_code,u.symbol,
    p.sale_step::text,p.sale_unit_price_nok::text,i.quantity::text,counted.last_counted_at,
    cab.code,cab.outer_row,cab.outer_col,cab.inner_rows,cab.inner_cols,
    b.code,b.label,b.inner_row,b.inner_col,b.row_span,b.col_span,p.location_note,
    p.datasheet_url,
    coalesce((SELECT jsonb_object_agg(d.code,jsonb_build_object('label',d.label,
      'unit',d.canonical_unit,'value_type',d.value_type,
      'value',coalesce(to_jsonb(a.number_value::text),to_jsonb(a.text_value),to_jsonb(a.boolean_value)),
      'max',to_jsonb(a.number_max::text)))
      FROM app.product_attributes a JOIN app.attribute_definitions d ON d.id=a.attribute_id
      WHERE a.product_id=p.id),'{}'::jsonb),
    coalesce((SELECT dist.codes FROM variants dist WHERE dist.product_id=p.id),'{}'::text[])
  FROM page p JOIN app.units u ON u.code=p.unit_code
  LEFT JOIN app.categories c ON c.id=p.category_id
  LEFT JOIN LATERAL (SELECT coalesce(sum(m.quantity_delta),0) AS quantity
    FROM app.inventory_movements m WHERE m.product_id=p.id) i ON true
  LEFT JOIN LATERAL (SELECT max(e.recorded_at) AS last_counted_at FROM app.stock_counts sc
    JOIN app.inventory_events e ON e.id=sc.event_id WHERE sc.product_id=p.id) counted ON true
  LEFT JOIN app.bins b ON b.id=p.bin_id
  LEFT JOIN app.cabinets cab ON cab.id=b.cabinet_id
  ORDER BY p.sort_key;
END $$;
