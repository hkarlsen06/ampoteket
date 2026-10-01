-- Staff arrange the volunteer list by moving rows; nobody types order numbers.
-- New contacts go last, and only amp_reorder_help_contacts changes the order.
CREATE OR REPLACE FUNCTION app.guard_help_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.edit_revision IS DISTINCT FROM OLD.edit_revision THEN
      RAISE EXCEPTION 'STALE_HELP_CONTACT';
    END IF;
    -- A move is not an edit of the contact, so an open editor stays current.
    IF to_jsonb(NEW) - 'display_order' = to_jsonb(OLD) - 'display_order' THEN RETURN NEW; END IF;
    NEW.edit_revision := OLD.edit_revision + 1;
  ELSE
    -- ponytail: concurrent inserts can tie; (display_order,id) still orders them and the next move renumbers.
    NEW.display_order := coalesce((SELECT max(display_order) + 1 FROM app.help_contacts),0);
    NEW.edit_revision := 1; NEW.created_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE INSERT (display_order),UPDATE (display_order) ON app.help_contacts,public.amp_help_contacts FROM authenticated;

-- p_ids is every contact, drafts included, in the new order. A list that no
-- longer matches the table means someone else added a contact: re-read and retry.
CREATE FUNCTION public.amp_reorder_help_contacts(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_staff();
  PERFORM 1 FROM app.help_contacts ORDER BY id FOR UPDATE;
  IF p_ids IS NULL OR cardinality(p_ids) <> (SELECT count(*) FROM app.help_contacts)
     OR (SELECT count(DISTINCT c.id) FROM app.help_contacts c WHERE c.id = ANY(p_ids)) <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'STALE_HELP_ORDER';
  END IF;
  UPDATE app.help_contacts c SET display_order = o.position - 1
    FROM unnest(p_ids) WITH ORDINALITY AS o(id,position)
    WHERE c.id = o.id AND c.display_order <> o.position - 1;
END $$;
REVOKE ALL ON FUNCTION public.amp_reorder_help_contacts(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_reorder_help_contacts(uuid[]) TO authenticated;

NOTIFY pgrst,'reload schema';
