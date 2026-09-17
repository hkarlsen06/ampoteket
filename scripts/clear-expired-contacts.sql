-- OWNER MAINTENANCE ONLY. See docs/runbook-contact-retention.md.
-- The operator UUID MUST identify the person running this maintenance session;
-- owner access can impersonate anyone, so verify your own account before use.
-- No contact text or checkout identifiers are printed. Success prints one count.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
\if :{?operator_auth_user_id}
\else
  \prompt 'Your own verified active Supabase Auth UUID: ' operator_auth_user_id
\endif
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'operator_auth_user_id'::uuid,'role','authenticated')::text,true) AS operator_claims
\gset
DO $$
DECLARE
  cutoff timestamptz := clock_timestamp() - interval '2160 hours';
  checkout uuid;
  removed integer := 0;
BEGIN
  -- Refuse a disabled, deleted or unrelated Auth identity before any erasure.
  PERFORM app.require_staff();
  -- Same lock used by buyer confirmation and staff recovery. Do not skip locked
  -- rows: a zero result must not mean "there was work but another writer held it".
  FOR checkout IN
    SELECT c.id FROM app.checkouts c
    JOIN app.checkout_contacts contact ON contact.checkout_id=c.id
    WHERE c.created_at <= cutoff
      AND NOT EXISTS (SELECT 1 FROM app.sales s WHERE s.checkout_id=c.id)
    ORDER BY c.created_at,c.id
    LIMIT 100
    FOR UPDATE OF c
  LOOP
    -- A confirmation may have committed while the selection waited on its lock.
    -- This separate statement gets a fresh READ COMMITTED snapshot.
    IF EXISTS (SELECT 1 FROM app.checkouts c
      JOIN app.checkout_contacts contact ON contact.checkout_id=c.id
      WHERE c.id=checkout AND c.created_at<=cutoff
        AND NOT EXISTS (SELECT 1 FROM app.sales s WHERE s.checkout_id=c.id)) THEN
      IF (public.amp_clear_checkout_contact(checkout)->>'contact_removed')::boolean THEN
        removed := removed + 1;
      END IF;
    END IF;
  END LOOP;
  -- A concurrent scan/confirmation can invalidate every selected candidate.
  -- Do not return a misleading terminal zero if later eligible rows remain
  -- beyond this batch's LIMIT; ask the operator to retry from a new snapshot.
  IF removed=0 AND EXISTS (
    SELECT 1 FROM app.checkouts c JOIN app.checkout_contacts contact ON contact.checkout_id=c.id
    WHERE c.created_at<=cutoff AND NOT EXISTS (SELECT 1 FROM app.sales s WHERE s.checkout_id=c.id)
  ) THEN
    RAISE EXCEPTION 'CONTACT_RETENTION_RETRY_REQUIRED' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('amp.retention_removed',removed::text,true);
END $$;
SELECT current_setting('amp.retention_removed')::integer AS removed
\gset
COMMIT;
-- Emit the committed count, never a success-looking result before COMMIT.
SELECT :removed AS contacts_cleared;
