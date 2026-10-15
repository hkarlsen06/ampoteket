-- Products that look alike in the catalog (same category and primary value,
-- such as two 680 pF capacitors) name the specification that tells them apart
-- (125 V, 350 V). amp_catalog gains a `distinguishing` column: up to two
-- attribute codes, the same for every member of such a group.
--
-- A p_sort entry may carry a third element, the category's further
-- specifications in the order they are worth showing:
-- [category name, primary attribute code or null, [attribute codes]].
-- src/lib/product-specifications.ts sends its categorySpecifications.

-- A comparable value; empty text counts as missing.
CREATE FUNCTION app.catalog_value_key(p_value app.product_attributes) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN p_value.number_value IS NOT NULL THEN to_jsonb(trim_scale(p_value.number_value)::text)
    WHEN p_value.text_value<>'' THEN to_jsonb(p_value.text_value)
    WHEN p_value.boolean_value IS NOT NULL THEN to_jsonb(p_value.boolean_value) END
$$;
REVOKE ALL ON FUNCTION app.catalog_value_key(app.product_attributes) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.catalog_attribute_key(p_product_id uuid,p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.catalog_value_key(a) FROM app.product_attributes a
  JOIN app.attribute_definitions d ON d.id=a.attribute_id WHERE a.product_id=p_product_id AND d.code=p_code
$$;
REVOKE ALL ON FUNCTION app.catalog_attribute_key(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Within a category, products with the same primary value look alike; without
-- one (Miscellaneous, or a value not entered) the Norwegian name stands in.
CREATE FUNCTION app.catalog_group_key(p_product app.products,p_primary text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT jsonb_build_array('value',v.key) FROM (SELECT app.catalog_attribute_key(p_product.id,p_primary) AS key) v WHERE v.key IS NOT NULL),
    jsonb_build_array('name',lower(regexp_replace(btrim(normalize(p_product.name_nb,NFC)),'\s+',' ','g'))))
$$;
REVOKE ALL ON FUNCTION app.catalog_group_key(app.products,text) FROM PUBLIC,anon,authenticated,service_role;

-- For each group with a listed product and at least two active members: take
-- specifications in the category's order, then the rest by code, keeping one
-- only if it splits members that still look alike, until all differ or two
-- are kept. A missing value counts as different. Members that nothing tells
-- apart keep what was found; they need a specification entered.
CREATE FUNCTION app.catalog_distinguishing(p_ids uuid[],p_sort jsonb) RETURNS TABLE (product_id uuid,codes text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE g record; v_candidates text[]; v_codes text[]; v_code text; v_groups bigint; v_next bigint;
BEGIN
  FOR g IN
    WITH entries AS (
      SELECT e.value->>0 AS category,e.value->>1 AS primary_code,coalesce(e.value->2,'[]'::jsonb) AS ordered
      FROM jsonb_array_elements(p_sort) e(value)
    ), keyed AS MATERIALIZED (
      SELECT p.id,p.category_id,s.primary_code,coalesce(s.ordered,'[]'::jsonb) AS ordered,app.catalog_group_key(p,s.primary_code) AS key
      FROM app.products p LEFT JOIN app.categories c ON c.id=p.category_id LEFT JOIN entries s ON s.category=c.name
      WHERE p.is_active AND EXISTS (SELECT 1 FROM app.products listed
        WHERE listed.id=ANY(p_ids) AND listed.category_id IS NOT DISTINCT FROM p.category_id)
    )
    SELECT k.primary_code,k.ordered,array_agg(k.id ORDER BY k.id) AS members,
      array_agg(k.id) FILTER (WHERE k.id=ANY(p_ids)) AS listed
    FROM keyed k GROUP BY k.category_id,k.key,k.primary_code,k.ordered
    HAVING count(*)>1 AND bool_or(k.id=ANY(p_ids))
  LOOP
    v_candidates := ARRAY(SELECT o.code FROM jsonb_array_elements_text(g.ordered) WITH ORDINALITY o(code,n)
      WHERE o.code IS DISTINCT FROM g.primary_code ORDER BY o.n);
    v_candidates := v_candidates||ARRAY(SELECT DISTINCT d.code FROM app.product_attributes a
      JOIN app.attribute_definitions d ON d.id=a.attribute_id
      WHERE a.product_id=ANY(g.members) AND d.code IS DISTINCT FROM g.primary_code AND NOT d.code=ANY(v_candidates)
      ORDER BY d.code);
    v_codes := '{}'; v_groups := 1;
    FOREACH v_code IN ARRAY v_candidates LOOP
      EXIT WHEN cardinality(v_codes)=2 OR v_groups=cardinality(g.members);
      SELECT count(DISTINCT s.signature) INTO v_next FROM (
        SELECT (SELECT jsonb_agg(app.catalog_attribute_key(m.id,k.code) ORDER BY k.n)
          FROM unnest(v_codes||v_code) WITH ORDINALITY k(code,n)) AS signature
        FROM unnest(g.members) m(id)) s;
      IF v_next>v_groups THEN v_codes := v_codes||v_code; v_groups := v_next; END IF;
    END LOOP;
    RETURN QUERY SELECT l.id,v_codes FROM unnest(g.listed) l(id);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.catalog_distinguishing(uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role;

DROP FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[],jsonb);
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
      'value',coalesce(to_jsonb(a.number_value::text),to_jsonb(a.text_value),to_jsonb(a.boolean_value))))
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
REVOKE ALL ON FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_catalog(text,text,integer,text,text[],jsonb,uuid,jsonb,uuid[],uuid[],jsonb) TO anon,authenticated,service_role;
