-- One operational role: every active member may invite or deactivate another.
-- Staff identities and their audit history survive revocation and Auth deletion.
CREATE FUNCTION public.amp_list_staff() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_staff();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'auth_user_id',s.auth_user_id,'display_name',s.display_name,
    'email',u.email,'is_active',s.is_active,'email_confirmed',u.email_confirmed_at IS NOT NULL
  ) ORDER BY s.is_active DESC,lower(s.display_name),s.id),'[]'::jsonb)
  FROM app.staff_members s LEFT JOIN auth.users u ON u.id=s.auth_user_id);
END $$;
REVOKE ALL ON FUNCTION public.amp_list_staff() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.amp_list_staff() TO authenticated;

CREATE FUNCTION public.amp_grant_staff_access(p_request_id uuid,p_email text,p_display_name text,p_expected_staff_id uuid DEFAULT NULL,p_expected_active boolean DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.require_staff(); v_cached jsonb;
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_name text := btrim(coalesce(p_display_name,''));
  v_matches uuid[]; v_staff uuid; v_active boolean;
BEGIN
  PERFORM app.require_read_committed();
  -- ponytail: rare access changes share one table lock; use a dedicated lock row if membership churn becomes material.
  LOCK TABLE app.staff_members IN SHARE ROW EXCLUSIVE MODE;
  v_actor := app.require_staff();
  v_cached := app.begin_command(p_request_id,'grant_staff_access',v_actor,
    jsonb_build_object('email',v_email,'display_name',v_name,'expected_staff_id',p_expected_staff_id,'expected_active',p_expected_active));
  IF v_cached IS NOT NULL THEN RETURN (v_cached->>'staff_id')::uuid; END IF;
  IF v_email = '' OR char_length(v_email)>254 THEN RAISE EXCEPTION 'STAFF_EMAIL_REQUIRED'; END IF;
  IF v_name = '' OR char_length(v_name)>120 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'STAFF_DISPLAY_NAME_REQUIRED';
  END IF;
  SELECT array_agg(id) INTO v_matches FROM auth.users WHERE lower(email)=v_email;
  IF coalesce(cardinality(v_matches),0)<>1 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND'; END IF;
  SELECT id,is_active INTO v_staff,v_active FROM app.staff_members WHERE auth_user_id=v_matches[1];
  IF p_expected_staff_id IS NOT NULL AND (v_staff IS DISTINCT FROM p_expected_staff_id
    OR (p_expected_active IS NOT NULL AND v_active IS DISTINCT FROM p_expected_active)) THEN
    RAISE EXCEPTION 'INVITATION_SUPERSEDED';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO app.staff_members(auth_user_id,display_name) VALUES(v_matches[1],v_name) RETURNING id INTO v_staff;
  ELSIF NOT v_active THEN
    UPDATE app.staff_members SET display_name=v_name,is_active=true WHERE id=v_staff;
  END IF;
  PERFORM app.finish_command(p_request_id,jsonb_build_object('staff_id',v_staff));
  RETURN v_staff;
END $$;
REVOKE ALL ON FUNCTION public.amp_grant_staff_access(uuid,text,text,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.amp_grant_staff_access(uuid,text,text,uuid,boolean) TO authenticated;

CREATE FUNCTION public.amp_deactivate_staff(p_request_id uuid,p_staff_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
BEGIN
  PERFORM app.require_read_committed();
  LOCK TABLE app.staff_members IN SHARE ROW EXCLUSIVE MODE;
  -- A member revoked while waiting must not revoke the member who just won.
  v_actor := app.require_staff();
  v_cached := app.begin_command(p_request_id,'deactivate_staff',v_actor,jsonb_build_object('staff_id',p_staff_id));
  IF v_cached IS NOT NULL THEN RETURN (v_cached->>'staff_id')::uuid; END IF;
  IF p_staff_id=v_actor THEN RAISE EXCEPTION 'STAFF_SELF_DEACTIVATION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.staff_members WHERE id=p_staff_id) THEN RAISE EXCEPTION 'STAFF_NOT_FOUND'; END IF;
  UPDATE app.staff_members SET is_active=false WHERE id=p_staff_id AND is_active;
  PERFORM app.finish_command(p_request_id,jsonb_build_object('staff_id',p_staff_id));
  RETURN p_staff_id;
END $$;
REVOKE ALL ON FUNCTION public.amp_deactivate_staff(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.amp_deactivate_staff(uuid,uuid) TO authenticated;

-- Keep privileged bootstrap/recovery access outside the API, using the same
-- serialization as ordinary membership changes. Existing maintainer semantics
-- (including STAFF_ALREADY_ACTIVE) stay intact.
CREATE OR REPLACE FUNCTION app.grant_staff_access(p_email text,p_display_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := btrim(coalesce(p_email,''));
  v_name text := btrim(coalesce(p_display_name,''));
  v_matches uuid[]; v_staff uuid; v_active boolean;
BEGIN
  PERFORM app.require_read_committed();
  LOCK TABLE app.staff_members IN SHARE ROW EXCLUSIVE MODE;
  IF v_email = '' THEN RAISE EXCEPTION 'STAFF_EMAIL_REQUIRED'; END IF;
  IF v_name = '' OR char_length(v_name)>120 THEN RAISE EXCEPTION 'STAFF_DISPLAY_NAME_REQUIRED'; END IF;
  SELECT array_agg(id) INTO v_matches FROM auth.users WHERE lower(email)=lower(v_email);
  IF coalesce(cardinality(v_matches),0)=0 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: %',v_email; END IF;
  IF cardinality(v_matches)>1 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: several accounts share %',v_email; END IF;
  SELECT id,is_active INTO v_staff,v_active FROM app.staff_members WHERE auth_user_id=v_matches[1];
  IF FOUND THEN
    IF v_active THEN RAISE EXCEPTION 'STAFF_ALREADY_ACTIVE: %',v_email; END IF;
    UPDATE app.staff_members SET display_name=v_name,is_active=true WHERE id=v_staff;
    RETURN v_staff;
  END IF;
  INSERT INTO app.staff_members(auth_user_id,display_name) VALUES(v_matches[1],v_name) RETURNING id INTO v_staff;
  RETURN v_staff;
END $$;
REVOKE ALL ON FUNCTION app.grant_staff_access(text,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app.revoke_staff_access(p_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email text := btrim(coalesce(p_email,'')); v_matches uuid[]; v_staff uuid;
BEGIN
  PERFORM app.require_read_committed();
  LOCK TABLE app.staff_members IN SHARE ROW EXCLUSIVE MODE;
  IF v_email = '' THEN RAISE EXCEPTION 'STAFF_EMAIL_REQUIRED'; END IF;
  SELECT array_agg(id) INTO v_matches FROM auth.users WHERE lower(email)=lower(v_email);
  IF coalesce(cardinality(v_matches),0)=0 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: %',v_email; END IF;
  IF cardinality(v_matches)>1 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: several accounts share %',v_email; END IF;
  SELECT id INTO v_staff FROM app.staff_members WHERE auth_user_id=v_matches[1] AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_ACTIVE: %',v_email; END IF;
  UPDATE app.staff_members SET is_active=false WHERE id=v_staff;
  RETURN v_staff;
END $$;
REVOKE ALL ON FUNCTION app.revoke_staff_access(text) FROM PUBLIC, anon, authenticated, service_role;
