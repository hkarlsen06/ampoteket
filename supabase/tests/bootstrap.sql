-- Minimal Auth stand-in for scripts/test-database.sh's disposable PostgreSQL.
-- test-api.sh verifies signed JWTs with PostgREST; actual Supabase Auth
-- lifecycle and browser/Worker integration still require the full stack.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
