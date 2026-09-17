-- Archive an empty cabinet and all its live drawers as one reviewed command.
-- The complete snapshots keep a confirmation from silently applying to a
-- changed layout; the command record makes a lost-response retry harmless.
CREATE FUNCTION public.amp_archive_empty_cabinet(
  p_request_id uuid, p_before jsonb, p_before_bins jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.require_staff();
  v_cached jsonb;
  v_cabinet_id uuid;
  v_current app.cabinets%ROWTYPE;
  v_bins jsonb;
  v_before_bins jsonb;
  v_count integer;
BEGIN
  v_cached := app.begin_command(p_request_id,'archive_empty_cabinet',v_actor,
    jsonb_build_object('before',p_before,'before_bins',p_before_bins));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF jsonb_typeof(p_before) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_before_bins) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  IF jsonb_array_length(p_before_bins)>4096
     OR jsonb_typeof(p_before->'id') IS DISTINCT FROM 'string'
     OR (p_before->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_before_bins) AS item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(item.value->'id') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  v_cabinet_id := (p_before->>'id')::uuid;
  -- Match the layout editor's bin-before-cabinet lock order. A concurrent
  -- insertion waits on the cabinet lock, then the complete set is reread.
  PERFORM 1 FROM app.bins b
    WHERE (b.cabinet_id=v_cabinet_id AND NOT b.is_archived)
       OR b.id::text IN (SELECT item.value->>'id' FROM jsonb_array_elements(p_before_bins) AS item(value))
    ORDER BY b.id FOR UPDATE;
  SELECT * INTO v_current FROM app.cabinets WHERE id=v_cabinet_id FOR UPDATE;
  IF v_current.id IS NULL OR v_current.is_archived
     OR to_jsonb(v_current) IS DISTINCT FROM p_before THEN
    RAISE EXCEPTION 'STALE_SHELF_LAYOUT';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb)
    INTO v_bins FROM app.bins b WHERE b.cabinet_id=v_cabinet_id AND NOT b.is_archived;
  SELECT coalesce(jsonb_agg(item.value ORDER BY item.value->>'id'),'[]'::jsonb)
    INTO v_before_bins FROM jsonb_array_elements(p_before_bins) AS item(value);
  IF v_bins IS DISTINCT FROM v_before_bins THEN
    RAISE EXCEPTION 'STALE_SHELF_LAYOUT';
  END IF;
  IF EXISTS (SELECT 1 FROM app.products p JOIN app.bins b ON b.id=p.bin_id
             WHERE b.cabinet_id=v_cabinet_id AND NOT b.is_archived) THEN
    RAISE EXCEPTION 'BIN_STILL_HAS_PRODUCTS';
  END IF;
  v_count := jsonb_array_length(v_bins);
  UPDATE app.bins SET is_archived=true WHERE cabinet_id=v_cabinet_id AND NOT is_archived;
  UPDATE app.cabinets SET is_archived=true WHERE id=v_cabinet_id;
  RETURN app.finish_command(p_request_id,
    jsonb_build_object('cabinet_id',v_cabinet_id,'archived_bins',v_count));
END $$;
REVOKE ALL ON FUNCTION public.amp_archive_empty_cabinet(uuid,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_archive_empty_cabinet(uuid,jsonb,jsonb)
  TO authenticated;

-- An archived bin has no current coordinates. Its latest archive audit image
-- contains the former bin position. Reconstruct the cabinet state at that
-- event from the nearest audit image, including seed cabinets created before
-- audit triggers existed. This remains a staff-only, read-only projection.
CREATE VIEW public.amp_archived_bin_locations WITH (security_invoker=true) AS
SELECT b.id AS bin_id,
  (archive.before_data->>'cabinet_id')::uuid AS cabinet_id,
  cabinet_state.value->>'code' AS cabinet_code,
  cabinet_state.value->>'label' AS cabinet_label,
  (cabinet_state.value->>'outer_row')::integer AS cabinet_outer_row,
  (cabinet_state.value->>'outer_col')::integer AS cabinet_outer_col,
  (archive.before_data->>'inner_row')::integer AS inner_row,
  (archive.before_data->>'inner_col')::integer AS inner_col,
  (archive.before_data->>'row_span')::integer AS row_span,
  (archive.before_data->>'col_span')::integer AS col_span
FROM app.bins b
JOIN LATERAL (
  SELECT a.id,a.before_data FROM app.audit_log a
  WHERE a.table_name='bins' AND a.row_key->>'id'=b.id::text
    AND a.action='UPDATE' AND a.before_data->>'is_archived'='false'
    AND a.after_data->>'is_archived'='true'
  ORDER BY a.id DESC LIMIT 1
) archive ON true
JOIN app.cabinets c ON c.id=(archive.before_data->>'cabinet_id')::uuid
LEFT JOIN LATERAL (
  SELECT a.after_data FROM app.audit_log a
  WHERE a.table_name='cabinets' AND a.row_key->>'id'=c.id::text AND a.id<archive.id
  ORDER BY a.id DESC LIMIT 1
) earlier ON true
LEFT JOIN LATERAL (
  SELECT a.before_data FROM app.audit_log a
  WHERE a.table_name='cabinets' AND a.row_key->>'id'=c.id::text AND a.id>archive.id
  ORDER BY a.id LIMIT 1
) later ON true
CROSS JOIN LATERAL (
  SELECT coalesce(earlier.after_data,later.before_data,to_jsonb(c)) AS value
) cabinet_state
WHERE b.is_archived;
REVOKE ALL ON public.amp_archived_bin_locations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.amp_archived_bin_locations TO authenticated;

NOTIFY pgrst,'reload schema';
