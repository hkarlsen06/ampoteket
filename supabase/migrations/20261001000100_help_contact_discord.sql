-- Volunteers are mostly reached on the workshop Discord, so a Discord username
-- alone is enough to publish a help contact. The responsibility says what to ask them about.
ALTER TABLE app.help_contacts
  ADD COLUMN responsibility text CHECK (responsibility IS NULL OR (length(btrim(responsibility)) >= 1 AND length(btrim(responsibility)) <= 80
    AND responsibility !~ '[[:cntrl:]]')),
  -- Current Discord usernames: 2–32 of a-z, 0-9, '_' and '.', never two periods in a row.
  ADD COLUMN discord text CHECK (discord IS NULL OR (discord ~ '^[a-z0-9_.]{2,32}$' AND discord !~ '\.\.'));
ALTER TABLE app.help_contacts DROP CONSTRAINT help_contacts_check;
ALTER TABLE app.help_contacts ADD CONSTRAINT help_contacts_check
  CHECK (NOT is_published OR num_nonnulls(email,phone,contact_url,discord) > 0);

-- SELECT * views keep the columns they were created with; replacing appends the new ones.
CREATE OR REPLACE VIEW public.amp_help_contacts WITH (security_invoker=true) AS SELECT * FROM app.help_contacts;
GRANT INSERT (responsibility,discord) ON app.help_contacts,public.amp_help_contacts TO authenticated;
GRANT UPDATE (responsibility,discord) ON app.help_contacts,public.amp_help_contacts TO authenticated;

DROP FUNCTION public.amp_help_directory(integer,uuid,integer);
CREATE FUNCTION public.amp_help_directory(p_after_order integer DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid,display_name text,responsibility text,email text,phone text,contact_url text,
  discord text,display_order integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'INVALID_HELP_PAGE_SIZE';
  END IF;
  IF (p_after_order IS NULL) <> (p_after_id IS NULL) OR p_after_order < 0 THEN
    RAISE EXCEPTION 'INVALID_HELP_CURSOR';
  END IF;
  RETURN QUERY SELECT c.id,c.display_name,c.responsibility,c.email,c.phone,c.contact_url,c.discord,c.display_order
    FROM app.help_contacts c WHERE c.is_published
      AND (p_after_order IS NULL OR (c.display_order,c.id) > (p_after_order,p_after_id))
    ORDER BY c.display_order,c.id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.amp_help_directory(integer,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_help_directory(integer,uuid,integer) TO anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
