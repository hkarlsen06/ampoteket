-- The catalog lists products by category, then by the category's primary
-- specification (resistors by resistance, capacitors by capacitance), instead
-- of by random part code. p_sort is the caller's ordered list of
-- [category name, attribute code or null] pairs; src/lib/catalog.ts derives it
-- from the standard product types and their first suggested specification.
-- Unlisted categories follow in name order, uncategorised products last.
-- Products without the primary value follow their category's valued ones.
CREATE TYPE app.catalog_sort_key AS (
  category_rank integer,category text,missing boolean,number_value numeric,text_value text,name text,code text);

-- One key for ORDER BY and the cursor, so pages always continue where the last
-- row sorts. No member is null: record comparison then needs no null rules.
CREATE FUNCTION app.catalog_sort_key(p_product app.products,p_sort jsonb) RETURNS app.catalog_sort_key
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ROW(coalesce(s.rank,CASE WHEN c.name IS NULL THEN 2147483647 ELSE 2147483646 END),
    coalesce(c.name,''),v.number_value IS NULL AND v.text_value IS NULL,
    coalesce(v.number_value,0),coalesce(v.text_value,''),p_product.name_nb,p_product.code)::app.catalog_sort_key
  FROM (SELECT 1) one
  LEFT JOIN app.categories c ON c.id=p_product.category_id
  LEFT JOIN LATERAL (SELECT e.ordinality::integer AS rank,e.value->>1 AS attribute
    FROM jsonb_array_elements(p_sort) WITH ORDINALITY e(value,ordinality) WHERE e.value->>0=c.name) s ON true
  LEFT JOIN LATERAL (SELECT a.number_value,a.text_value FROM app.product_attributes a
    JOIN app.attribute_definitions d ON d.id=a.attribute_id WHERE a.product_id=p_product.id AND d.code=s.attribute) v ON true
$$;
REVOKE ALL ON FUNCTION app.catalog_sort_key(app.products,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DROP FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[]);
-- The cursor stays the last row's immutable code; its current sort key locates
-- the next page. Continue until an empty page, even after a short page: an API
-- row cap may be smaller than p_limit.
CREATE FUNCTION public.amp_catalog(p_code text DEFAULT NULL,p_after_code text DEFAULT NULL,
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
  datasheet_url text,attributes jsonb
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
      WHEN jsonb_typeof(e)<>'array' THEN true WHEN jsonb_array_length(e)<>2 THEN true
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
  )
  SELECT p.id,p.code,p.name_nb,p.name_en,p.description,c.name,p.unit_code,u.symbol,
    p.sale_step::text,p.sale_unit_price_nok::text,i.quantity::text,counted.last_counted_at,
    cab.code,cab.outer_row,cab.outer_col,cab.inner_rows,cab.inner_cols,
    b.code,b.label,b.inner_row,b.inner_col,b.row_span,b.col_span,p.location_note,
    p.datasheet_url,
    coalesce((SELECT jsonb_object_agg(d.code,jsonb_build_object('label',d.label,
      'unit',d.canonical_unit,'value_type',d.value_type,
      'value',coalesce(to_jsonb(a.number_value::text),to_jsonb(a.text_value),to_jsonb(a.boolean_value))))
      FROM app.product_attributes a JOIN app.attribute_definitions d ON d.id=a.attribute_id
      WHERE a.product_id=p.id),'{}'::jsonb)
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
REVOKE ALL ON FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[],jsonb) TO anon,authenticated,service_role;
