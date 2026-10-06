-- Fresh install: known physical storage and published volunteers, no invented inventory.
DO $$ DECLARE t record; n bigint; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' AND tablename NOT IN ('units','cabinets','bins','help_contacts','audit_log') LOOP
    EXECUTE format('SELECT count(*) FROM app.%I',t.tablename) INTO n;
    IF n<>0 THEN RAISE EXCEPTION 'FRESH_SCHEMA_HAS_INVENTED_FACTS: %',t.tablename; END IF;
  END LOOP;
  IF (SELECT count(*) FROM app.units)<>3
     OR NOT EXISTS (SELECT FROM app.units WHERE code='pcs' AND is_discrete)
     OR NOT EXISTS (SELECT FROM app.units WHERE code='m' AND NOT is_discrete)
     OR NOT EXISTS (SELECT FROM app.units WHERE code='g' AND NOT is_discrete)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_UNITS_MISMATCH'; END IF;
  -- Migrations audit only their own inserts, without a staff actor: 12 published
  -- volunteers and the gram unit.
  IF (SELECT count(*) FROM app.help_contacts WHERE is_published AND discord IS NOT NULL)<>12
     OR EXISTS (SELECT FROM app.help_contacts WHERE NOT is_published OR discord IS NULL)
     OR (SELECT count(*) FROM app.audit_log)<>13
     OR (SELECT count(*) FROM app.audit_log WHERE table_name='help_contacts')<>12
     OR (SELECT count(*) FROM app.audit_log WHERE table_name='units')<>1
     OR EXISTS (SELECT FROM app.audit_log WHERE table_name NOT IN ('help_contacts','units') OR action<>'INSERT' OR actor_id IS NOT NULL)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_VOLUNTEERS_MISMATCH'; END IF;
  IF (SELECT count(*) FROM app.cabinets)<>12 OR (SELECT count(*) FROM app.bins)<>492
     OR (SELECT sum(inner_rows*inner_cols) FROM app.cabinets)<>496
     OR EXISTS (SELECT 1 FROM app.cabinet_free_cells)
     OR EXISTS (SELECT 1 FROM app.cabinets WHERE is_archived OR label IS NOT NULL)
     OR EXISTS (SELECT 1 FROM app.bins WHERE is_archived OR label IS NOT NULL)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_LAYOUT_SIZE_MISMATCH'; END IF;
  IF EXISTS (
    WITH expected(outer_row,outer_col,inner_rows,inner_cols) AS (VALUES
      (1,1,12,4),(1,2,12,4),(1,3,12,4),(1,4,12,4),(1,5,8,3),(1,6,8,3),
      (2,1,8,3),(2,2,12,4),(2,3,10,4),(2,4,12,4),(2,5,12,4),(2,6,12,4))
    SELECT 1 FROM expected e FULL JOIN app.cabinets c USING(outer_row,outer_col,inner_rows,inner_cols)
    WHERE e.outer_row IS NULL OR c.id IS NULL)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_CABINET_LAYOUT_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM app.cabinets c CROSS JOIN LATERAL generate_series(1,c.inner_rows) r
    CROSS JOIN LATERAL generate_series(1,c.inner_cols) col
    WHERE (SELECT count(*) FROM app.bins b WHERE b.cabinet_id=c.id
      AND r BETWEEN b.inner_row AND b.inner_row+b.row_span-1
      AND col BETWEEN b.inner_col AND b.inner_col+b.col_span-1)<>1)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_DRAWER_COVERAGE_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id
    WHERE b.row_span<>1 OR b.col_span IS DISTINCT FROM
      CASE WHEN (c.outer_row,c.outer_col,b.inner_row,b.inner_col)=(2,3,1,1) THEN 4
           WHEN (c.outer_row,c.outer_col,b.inner_row,b.inner_col)=(2,3,2,3) THEN 2 ELSE 1 END)
    OR NOT EXISTS (SELECT 1 FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id
      WHERE (c.outer_row,c.outer_col,b.inner_row,b.inner_col,b.row_span,b.col_span)=(2,3,1,1,1,4))
    OR NOT EXISTS (SELECT 1 FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id
      WHERE (c.outer_row,c.outer_col,b.inner_row,b.inner_col,b.row_span,b.col_span)=(2,3,2,3,1,2))
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_SPANNING_DRAWER_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.amp_shelf_map()->'bins') b
    WHERE b->'has_products' IS DISTINCT FROM 'false'::jsonb)
  THEN RAISE EXCEPTION 'FRESH_SCHEMA_INVENTED_DRAWER_CONTENTS'; END IF;
  RAISE NOTICE 'PASS: initial workbook layout has 12 cabinets, 496 cells, 492 drawers, 12 volunteers and no invented inventory';
END $$;
