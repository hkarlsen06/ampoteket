-- A row lock serializes moves but does not make a stale whole-list edit safe.
-- Remove the unguarded signature so an older client fails without changing order.
DROP FUNCTION public.amp_reorder_help_contacts(uuid[]);
CREATE FUNCTION public.amp_reorder_help_contacts(p_ids uuid[],p_expected_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_current uuid[];
BEGIN
  PERFORM app.require_staff();
  PERFORM app.require_read_committed();
  PERFORM 1 FROM app.help_contacts ORDER BY id FOR UPDATE;
  SELECT coalesce(array_agg(id ORDER BY display_order,id),'{}'::uuid[])
    INTO v_current FROM app.help_contacts;
  IF p_ids IS NULL OR p_expected_ids IS NULL OR cardinality(p_ids) <> cardinality(v_current)
     OR (SELECT count(DISTINCT id) FROM unnest(p_ids) id WHERE id=ANY(v_current)) <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'STALE_HELP_ORDER';
  END IF;
  -- A lost-response retry succeeds without another audit update. A later,
  -- different move must still match the complete order that its caller read.
  IF p_ids = v_current THEN RETURN; END IF;
  IF p_expected_ids IS DISTINCT FROM v_current THEN RAISE EXCEPTION 'STALE_HELP_ORDER'; END IF;
  UPDATE app.help_contacts c SET display_order = o.position - 1
    FROM unnest(p_ids) WITH ORDINALITY AS o(id,position)
    WHERE c.id = o.id AND c.display_order <> o.position - 1;
END $$;
REVOKE ALL ON FUNCTION public.amp_reorder_help_contacts(uuid[],uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_reorder_help_contacts(uuid[],uuid[]) TO authenticated;

NOTIFY pgrst,'reload schema';
