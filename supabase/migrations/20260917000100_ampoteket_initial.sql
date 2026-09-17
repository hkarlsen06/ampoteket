-- Ampoteket database v1. PostgreSQL 15+ / Supabase.
-- Apply first to a disposable LOCAL Supabase project, not production.
-- app is internal and must NOT be added to Data API exposed schemas.
-- public contains the deliberately exposed views and RPC functions.
-- The migration runner owns the transaction, including migration history.
-- Standalone disposable validation requires psql --single-transaction.

CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
-- Schema-local defaults cannot revoke PostgreSQL's global PUBLIC EXECUTE.
-- Revoke/grant every new function explicitly in its creating transaction;
-- the permission regression test checks the complete application API surface.

-- Unconstrained numeric + CHECK deliberately REJECTS excess decimal precision;
-- numeric(p,s) would round inputs before constraints see the original value.
CREATE DOMAIN app.quantity AS numeric
  CHECK (VALUE BETWEEN -999999999999 AND 999999999999
         AND VALUE = trunc(VALUE, 6));
-- Accumulated balances and count differences must remain representable after
-- any sequence of valid commands. Commands retain the smaller quantity bound.
CREATE DOMAIN app.stock_quantity AS numeric
  CHECK (VALUE > '-Infinity'::numeric AND VALUE < 'Infinity'::numeric
         AND VALUE = trunc(VALUE, 6));
CREATE DOMAIN app.unit_price AS numeric
  CHECK (VALUE BETWEEN 0 AND 999999999999 AND VALUE = trunc(VALUE, 6));
CREATE DOMAIN app.nok_amount AS numeric
  CHECK (VALUE BETWEEN 0 AND 999999999999 AND VALUE = trunc(VALUE, 2));

CREATE TABLE app.units (
  code text PRIMARY KEY,
  name text NOT NULL,
  symbol text NOT NULL,
  is_discrete boolean NOT NULL,
  CHECK (code ~ '^[a-z][a-z0-9_]{0,23}$')
);
INSERT INTO app.units VALUES ('pcs','Piece','stk',true), ('m','Metre','m',false);

CREATE TABLE app.staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Public support contacts are independent of staff access and Auth identities.
-- These are intentionally publishable directory details, not buyer contact data.
CREATE TABLE app.help_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 120
    AND display_name !~ '[[:cntrl:]]'),
  email text CHECK (email IS NULL OR (length(email) <= 254
    AND email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$')),
  phone text CHECK (phone IS NULL OR (length(phone) >= 3 AND length(phone) <= 40
    AND phone ~ '^\+?[0-9][0-9 ()-]*[0-9]$'
    AND length(regexp_replace(phone,'[^0-9]','','g')) >= 3)),
  contact_url text CHECK (contact_url IS NULL OR (length(contact_url) <= 500
    AND contact_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$'
    AND contact_url !~ '[[:cntrl:]]'
    AND coalesce(substring(contact_url FROM '^https://[^/:?#]+:([0-9]+)')::integer,443) <= 65535)),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_published boolean NOT NULL DEFAULT false,
  edit_revision bigint NOT NULL DEFAULT 1 CHECK (edit_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT is_published OR num_nonnulls(email,phone,contact_url) > 0)
);
CREATE INDEX help_contacts_published_order_idx ON app.help_contacts(display_order,id) WHERE is_published;

CREATE TABLE app.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 100)
);
-- The workshop has one wall with one grid of cabinets. (outer_row, outer_col)
-- is a cabinet's position in that grid. At both wall and drawer levels, row 1
-- is the bottom row; rows increase upward and columns rightward from column 1
-- at the left, viewed from the front.
CREATE TABLE app.cabinets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  outer_row integer CHECK (outer_row > 0),
  outer_col integer CHECK (outer_col > 0),
  inner_rows integer NOT NULL CHECK (inner_rows > 0),
  inner_cols integer NOT NULL CHECK (inner_cols > 0),
  label text,
  is_archived boolean NOT NULL DEFAULT false,
  CHECK ((is_archived AND outer_row IS NULL AND outer_col IS NULL)
      OR (NOT is_archived AND outer_row IS NOT NULL AND outer_col IS NOT NULL)),
  CONSTRAINT cabinets_position_key UNIQUE (outer_row, outer_col) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK (length(btrim(code)) BETWEEN 1 AND 64)
);
-- A bin is one physical drawer or bulk position inside a cabinet.
-- (inner_row, inner_col) is the bottom-left unit cell; row_span extends upward
-- and col_span rightward, covering merged cells such as a full-row drawer.
-- Inner coordinates are logical finding addresses,
-- not millimetre-exact geometry: columns may have different physical widths.
-- Empty unit cells (no covering bin) are free drawer slots.
CREATE TABLE app.bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  cabinet_id uuid REFERENCES app.cabinets(id),
  inner_row integer CHECK (inner_row > 0),
  inner_col integer CHECK (inner_col > 0),
  row_span integer NOT NULL DEFAULT 1 CHECK (row_span > 0),
  col_span integer NOT NULL DEFAULT 1 CHECK (col_span > 0),
  label text,
  is_archived boolean NOT NULL DEFAULT false,
  CHECK ((is_archived AND cabinet_id IS NULL AND inner_row IS NULL AND inner_col IS NULL)
      OR (NOT is_archived AND cabinet_id IS NOT NULL AND inner_row IS NOT NULL AND inner_col IS NOT NULL))
);
CREATE INDEX bins_cabinet_idx ON app.bins(cabinet_id);

-- The workshop's physical cabinet layout. Coordinates count from bottom-left.
-- Only known storage is initialized: workbook x/o marks are not product or stock
-- records. Deterministic IDs are internal identities, never displayed addresses.
WITH layout(outer_row,outer_col,inner_rows,inner_cols) AS (VALUES
  (1,1,12,4),(1,2,12,4),(1,3,12,4),(1,4,12,4),(1,5,8,3),(1,6,8,3),
  (2,1,8,3),(2,2,12,4),(2,3,10,4),(2,4,12,4),(2,5,12,4),(2,6,12,4)
), identified AS (
  SELECT *,('a0000001-0000-4000-8000-'||lpad(to_hex(outer_col+6*(outer_row-1)),12,'0'))::uuid AS id
    FROM layout
)
INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols)
  SELECT id,'C-'||id,outer_row,outer_col,inner_rows,inner_cols FROM identified;
WITH cells AS (
  SELECT c.id AS cabinet_id,c.outer_row,c.outer_col,r AS inner_row,col AS inner_col,
    CASE WHEN c.outer_row=2 AND c.outer_col=3 AND r=1 AND col=1 THEN 4
         WHEN c.outer_row=2 AND c.outer_col=3 AND r=2 AND col=3 THEN 2 ELSE 1 END AS col_span,
    ('a0000002-0000-4000-8000-'||lpad(to_hex((c.outer_col+6*(c.outer_row-1)-1)*1000+(r-1)*10+col),12,'0'))::uuid AS id
  FROM app.cabinets c CROSS JOIN LATERAL generate_series(1,c.inner_rows) r
    CROSS JOIN LATERAL generate_series(1,c.inner_cols) col
  WHERE NOT (c.outer_row=2 AND c.outer_col=3 AND ((r=1 AND col>1) OR (r=2 AND col=4)))
)
INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col,row_span,col_span)
  SELECT id,'B-'||id,cabinet_id,inner_row,inner_col,1,col_span FROM cells;
-- Buyer-facing product names are published in both UI languages; Norwegian is
-- the source language (docs/i18n.md), English is required alongside it.
CREATE TABLE app.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,39}$'),
  name_nb text NOT NULL CHECK (length(btrim(name_nb)) BETWEEN 1 AND 200),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  description text,
  category_id uuid REFERENCES app.categories(id),
  bin_id uuid REFERENCES app.bins(id),
  -- Public finding hint for stock kept outside the drawer wall, e.g. filament.
  location_note text CHECK (location_note IS NULL OR length(btrim(location_note)) BETWEEN 1 AND 200),
  unit_code text NOT NULL REFERENCES app.units(code),
  stock_step app.quantity NOT NULL CHECK (stock_step > 0),
  sale_step app.quantity NOT NULL CHECK (sale_step > 0),
  sale_unit_price_nok app.unit_price NOT NULL,
  -- Staff-only restock level in the stock unit; 0 means no warning beyond sold out.
  minimum_stock app.quantity NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  datasheet_url text CHECK (datasheet_url IS NULL OR datasheet_url ~ '^https?://'),
  -- Staff-only standing reorder link, e.g. from before purchase history existed.
  purchase_url text CHECK (purchase_url IS NULL OR purchase_url ~ '^https?://'),
  is_active boolean NOT NULL DEFAULT false,
  metadata_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (mod(sale_step, stock_step) = 0),
  CHECK (mod(minimum_stock, stock_step) = 0),
  CHECK (bin_id IS NULL OR location_note IS NULL)
);
CREATE INDEX products_bin_idx ON app.products(bin_id);
CREATE INDEX products_category_idx ON app.products(category_id);

-- One scalar value per product/property. Canonical measurement units live on
-- the definition, e.g. resistance -> numeric -> ohm, never '1k' in a number.
CREATE TABLE app.attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  value_type text NOT NULL CHECK (value_type IN ('number','text','boolean')),
  canonical_unit text,
  CHECK (canonical_unit IS NULL OR value_type = 'number')
);
CREATE TABLE app.product_attributes (
  product_id uuid NOT NULL REFERENCES app.products(id),
  attribute_id uuid NOT NULL REFERENCES app.attribute_definitions(id),
  number_value numeric,
  text_value text,
  boolean_value boolean,
  PRIMARY KEY (product_id, attribute_id),
  CHECK (num_nonnulls(number_value, text_value, boolean_value) = 1),
  CHECK (number_value IS NULL OR
    (number_value > '-Infinity'::numeric AND number_value < 'Infinity'::numeric)),
  CHECK (text_value IS NULL OR length(text_value) <= 2000)
);
CREATE INDEX product_attributes_attribute_idx ON app.product_attributes(attribute_id);

-- A command is committed together with its business effects and result.
-- Only a digest is stored, never the raw request, checkout secret or contact.
CREATE TABLE app.command_requests (
  id uuid PRIMARY KEY,
  command_name text NOT NULL,
  actor_id uuid REFERENCES app.staff_members(id),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- All orders here have already been placed externally. There are no drafts.
CREATE TABLE app.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  supplier_name text NOT NULL CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 200),
  supplier_reference text,
  placed_at timestamptz NOT NULL,
  additional_cost_nok app.nok_amount NOT NULL DEFAULT 0,
  note text,
  created_by uuid NOT NULL REFERENCES app.staff_members(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Orders record what was already placed; a far-future placement time is a typo.
  CONSTRAINT placed_at_not_in_future CHECK (placed_at <= recorded_at + interval '1 day')
);
CREATE TABLE app.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.purchase_orders(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  product_id uuid NOT NULL REFERENCES app.products(id),
  ordered_quantity app.quantity NOT NULL CHECK (ordered_quantity > 0),
  unit_cost_nok app.unit_price NOT NULL,
  purchase_url text CHECK (purchase_url IS NULL OR purchase_url ~ '^https?://'),
  supplier_sku text,
  UNIQUE (order_id, line_number)
);
CREATE INDEX purchase_order_lines_product_idx ON app.purchase_order_lines(product_id);
CREATE INDEX purchase_orders_placed_idx ON app.purchase_orders(placed_at DESC);

CREATE TABLE app.purchase_order_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.command_requests(id),
  order_line_id uuid NOT NULL REFERENCES app.purchase_order_lines(id),
  quantity app.quantity NOT NULL CHECK (quantity > 0),
  -- A mistaken cancellation can be neutralised once, without deleting it.
  reverses_id uuid UNIQUE REFERENCES app.purchase_order_cancellations(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES app.staff_members(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id, order_line_id)
);
CREATE INDEX cancellations_line_idx ON app.purchase_order_cancellations(order_line_id);

CREATE TABLE app.checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.checkout_lines (
  checkout_id uuid NOT NULL REFERENCES app.checkouts(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  product_name_nb_snapshot text NOT NULL,
  product_name_en_snapshot text NOT NULL,
  quantity app.quantity NOT NULL CHECK (quantity > 0),
  unit_price_nok app.unit_price NOT NULL,
  PRIMARY KEY (checkout_id, product_id)
);
CREATE INDEX checkout_lines_product_idx ON app.checkout_lines(product_id);
CREATE TABLE app.checkout_contacts (
  checkout_id uuid PRIMARY KEY REFERENCES app.checkouts(id),
  contact_text text NOT NULL CHECK (length(btrim(contact_text)) BETWEEN 1 AND 300)
);

CREATE TABLE app.count_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.command_requests(id),
  owner_id uuid NOT NULL REFERENCES app.staff_members(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  finished_by uuid REFERENCES app.staff_members(id),
  finish_reason text CHECK (finish_reason IS NULL OR length(btrim(finish_reason)) BETWEEN 1 AND 2000),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((finished_at IS NULL) = (finished_by IS NULL)),
  CHECK (finish_reason IS NULL OR finished_at IS NOT NULL)
);
CREATE INDEX count_batches_owner_idx ON app.count_batches(owner_id);

-- An event groups one atomic inventory action. It is not a generic event bus.
-- Receipt and withdrawal headers reuse this table instead of separate headers.
CREATE TABLE app.inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid UNIQUE REFERENCES app.command_requests(id),
  kind text NOT NULL CHECK (kind IN ('receipt','sale','count','adjustment','withdrawal')),
  actor_id uuid REFERENCES app.staff_members(id),
  purchase_order_id uuid REFERENCES app.purchase_orders(id),
  note text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'sale' AND actor_id IS NULL) OR (kind <> 'sale' AND actor_id IS NOT NULL)),
  CHECK (kind = 'receipt' OR purchase_order_id IS NULL),
  CHECK (kind NOT IN ('adjustment','withdrawal') OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  CHECK (kind <> 'receipt' OR purchase_order_id IS NOT NULL OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  CHECK (note IS NULL OR length(note) <= 2000)
);
CREATE INDEX inventory_events_recorded_idx ON app.inventory_events(recorded_at DESC);
CREATE INDEX inventory_events_order_idx ON app.inventory_events(purchase_order_id);

CREATE TABLE app.inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app.inventory_events(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  quantity_delta app.stock_quantity NOT NULL CHECK (quantity_delta <> 0)
);
CREATE INDEX inventory_movements_product_idx ON app.inventory_movements(product_id, id);
CREATE INDEX inventory_movements_event_idx ON app.inventory_movements(event_id);
CREATE TABLE app.movement_corrections (
  movement_id bigint PRIMARY KEY REFERENCES app.inventory_movements(id),
  corrects_movement_id bigint NOT NULL REFERENCES app.inventory_movements(id),
  CHECK (movement_id > corrects_movement_id)
);
CREATE INDEX movement_corrections_original_idx ON app.movement_corrections(corrects_movement_id);

-- Allocates a receipt movement to a real order line. The quantity is held
-- once, in the movement. Signed receipt corrections inherit this allocation.
CREATE TABLE app.receipt_allocations (
  movement_id bigint PRIMARY KEY REFERENCES app.inventory_movements(id),
  order_line_id uuid NOT NULL REFERENCES app.purchase_order_lines(id)
);
CREATE INDEX receipt_allocations_line_idx ON app.receipt_allocations(order_line_id);

CREATE TABLE app.sales (
  checkout_id uuid PRIMARY KEY REFERENCES app.checkouts(id),
  event_id uuid NOT NULL UNIQUE REFERENCES app.inventory_events(id),
  recovered_by uuid REFERENCES app.staff_members(id),
  recovery_reason text,
  CHECK ((recovered_by IS NULL AND recovery_reason IS NULL)
      OR (recovered_by IS NOT NULL AND length(btrim(recovery_reason)) BETWEEN 1 AND 2000
          AND recovery_reason IS NOT NULL))
);
CREATE TABLE app.stock_counts (
  event_id uuid PRIMARY KEY REFERENCES app.inventory_events(id),
  batch_id uuid NOT NULL REFERENCES app.count_batches(id),
  product_id uuid NOT NULL REFERENCES app.products(id),
  expected_quantity app.stock_quantity NOT NULL,
  counted_quantity app.stock_quantity NOT NULL CHECK (counted_quantity >= 0),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0)
);
CREATE INDEX stock_counts_product_idx ON app.stock_counts(product_id);
CREATE INDEX stock_counts_batch_idx ON app.stock_counts(batch_id);

CREATE TABLE app.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_key jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','CONTACT_CLEARED')),
  before_data jsonb,
  after_data jsonb,
  actor_id uuid REFERENCES app.staff_members(id),
  database_role text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_log_recorded_idx ON app.audit_log(recorded_at DESC);

-- ---------- Identity, idempotency, quantity and locking helpers ----------
CREATE FUNCTION app.current_staff_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id FROM app.staff_members WHERE auth_user_id = auth.uid() AND is_active
$$;
CREATE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.current_staff_id() IS NOT NULL
$$;
CREATE FUNCTION app.require_staff() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  v_id := app.current_staff_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'STAFF_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN v_id;
END $$;
-- Maintainer-only staff access helpers for Supabase Studio (SQL editor). Auth
-- accounts are created in Studio first (Authentication → Add user); these link
-- them to operational access by email address, so no UUID juggling is needed.
-- They grant execution to nobody: only the database maintainer connection runs
-- them. Staff RLS deliberately has no INSERT/UPDATE policy on
-- app.staff_members, so these are the only write path besides the owner
-- connection. Writes are audited by the audit_metadata trigger.
CREATE FUNCTION app.grant_staff_access(p_email text, p_display_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := btrim(coalesce(p_email, ''));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_matches uuid[];
  v_staff uuid;
  v_active boolean;
BEGIN
  IF v_email = '' THEN RAISE EXCEPTION 'STAFF_EMAIL_REQUIRED'; END IF;
  IF v_name = '' OR char_length(v_name) > 120 THEN RAISE EXCEPTION 'STAFF_DISPLAY_NAME_REQUIRED'; END IF;
  SELECT array_agg(id) INTO v_matches FROM auth.users WHERE lower(email) = lower(v_email);
  IF coalesce(array_length(v_matches, 1), 0) = 0 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: %', v_email; END IF;
  IF array_length(v_matches, 1) > 1 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: several accounts share %', v_email; END IF;
  SELECT id, is_active INTO v_staff, v_active FROM app.staff_members WHERE auth_user_id = v_matches[1];
  IF FOUND THEN
    IF v_active THEN RAISE EXCEPTION 'STAFF_ALREADY_ACTIVE: %', v_email; END IF;
    UPDATE app.staff_members SET display_name = v_name, is_active = true WHERE id = v_staff;
    RETURN v_staff;
  END IF;
  INSERT INTO app.staff_members(auth_user_id, display_name) VALUES (v_matches[1], v_name) RETURNING id INTO v_staff;
  RETURN v_staff;
END $$;
REVOKE ALL ON FUNCTION app.grant_staff_access(text, text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION app.revoke_staff_access(p_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := btrim(coalesce(p_email, ''));
  v_matches uuid[];
  v_staff uuid;
BEGIN
  IF v_email = '' THEN RAISE EXCEPTION 'STAFF_EMAIL_REQUIRED'; END IF;
  SELECT array_agg(id) INTO v_matches FROM auth.users WHERE lower(email) = lower(v_email);
  IF coalesce(array_length(v_matches, 1), 0) = 0 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: %', v_email; END IF;
  IF array_length(v_matches, 1) > 1 THEN RAISE EXCEPTION 'STAFF_USER_NOT_FOUND: several accounts share %', v_email; END IF;
  SELECT id INTO v_staff FROM app.staff_members WHERE auth_user_id = v_matches[1] AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_ACTIVE: %', v_email; END IF;
  UPDATE app.staff_members SET is_active = false WHERE id = v_staff;
  RETURN v_staff;
END $$;
REVOKE ALL ON FUNCTION app.revoke_staff_access(text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION app.require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ_COMMITTED_REQUIRED';
  END IF;
END $$;
CREATE FUNCTION app.begin_command(p_id uuid, p_name text, p_actor uuid, p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r app.command_requests%ROWTYPE; v_digest bytea;
BEGIN
  PERFORM app.require_read_committed();
  IF p_id IS NULL THEN RAISE EXCEPTION 'REQUEST_ID_REQUIRED'; END IF;
  v_digest := sha256(convert_to(p_body::text, 'UTF8'));
  INSERT INTO app.command_requests(id,command_name,actor_id,request_digest)
    VALUES(p_id,p_name,p_actor,v_digest) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT r FROM app.command_requests WHERE id = p_id FOR UPDATE;
  IF r.command_name <> p_name OR r.actor_id IS DISTINCT FROM p_actor
     OR r.request_digest <> v_digest THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT';
  END IF;
  RETURN r.result;
END $$;
CREATE FUNCTION app.finish_command(p_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE app.command_requests SET result = p_result WHERE id = p_id AND result IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_COMMAND_COMPLETION'; END IF;
  RETURN p_result;
END $$;
CREATE FUNCTION app.check_items(p_items jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'ITEMS_MUST_BE_ARRAY'; END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_ITEM_COUNT'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS item(value) WHERE jsonb_typeof(item.value) <> 'object')
    THEN RAISE EXCEPTION 'INVALID_ITEM'; END IF;
END $$;
CREATE FUNCTION app.lock_products(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_ids IS NULL OR array_position(p_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'PRODUCT_ID_REQUIRED'; END IF;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_ids) x ORDER BY x LOOP
    PERFORM 1 FROM app.products WHERE id = v_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %',v_id; END IF;
  END LOOP;
END $$;
CREATE FUNCTION app.validate_quantity(p_product uuid, p_quantity numeric, p_sale boolean DEFAULT false,
  p_unbounded boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_step numeric; v_checked app.stock_quantity; v_command_quantity app.quantity;
BEGIN
  IF p_quantity IS NULL THEN RAISE EXCEPTION 'QUANTITY_REQUIRED'; END IF;
  v_checked := p_quantity;
  IF NOT p_unbounded THEN v_command_quantity := p_quantity; END IF;
  SELECT CASE WHEN p_sale THEN sale_step ELSE stock_step END INTO v_step
    FROM app.products WHERE id = p_product;
  IF v_step IS NULL THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  IF mod(p_quantity,v_step) <> 0 THEN RAISE EXCEPTION 'INVALID_QUANTITY_STEP'; END IF;
END $$;

-- ---------- Read models: no separately writable balance or order status ----------
CREATE VIEW app.inventory WITH (security_invoker = true) AS
SELECT p.id AS product_id,
       coalesce(s.quantity,0::numeric) AS quantity,
       coalesce(s.revision,0::bigint) AS revision,
       c.last_counted_at
FROM app.products p
LEFT JOIN (
  SELECT product_id,sum(quantity_delta) AS quantity,max(id) AS revision
  FROM app.inventory_movements GROUP BY product_id
) s ON s.product_id = p.id
LEFT JOIN (
  SELECT sc.product_id,max(e.recorded_at) AS last_counted_at
  FROM app.stock_counts sc JOIN app.inventory_events e ON e.id=sc.event_id
  GROUP BY sc.product_id
) c ON c.product_id=p.id;

CREATE VIEW app.purchase_line_progress WITH (security_invoker = true) AS
SELECT l.*, coalesce(r.received,0::numeric) AS received_quantity,
       coalesce(c.cancelled,0::numeric) AS cancelled_quantity,
       greatest(l.ordered_quantity-coalesce(r.received,0)-coalesce(c.cancelled,0),0::numeric)
         AS outstanding_quantity
FROM app.purchase_order_lines l
LEFT JOIN (
  SELECT a.order_line_id,sum(m.quantity_delta) AS received
  FROM app.receipt_allocations a JOIN app.inventory_movements m ON m.id=a.movement_id
  GROUP BY a.order_line_id
) r ON r.order_line_id=l.id
LEFT JOIN (
  SELECT order_line_id,sum(CASE WHEN reverses_id IS NULL THEN quantity ELSE -quantity END) AS cancelled
  FROM app.purchase_order_cancellations GROUP BY order_line_id
) c ON c.order_line_id=l.id;

CREATE VIEW app.latest_purchase WITH (security_invoker = true) AS
SELECT DISTINCT ON (l.product_id)
  l.product_id, l.id AS order_line_id, l.order_id, o.placed_at,
  l.unit_cost_nok, l.purchase_url
FROM app.purchase_line_progress l JOIN app.purchase_orders o ON o.id=l.order_id
WHERE l.unit_cost_nok > 0 AND (l.received_quantity > 0 OR l.outstanding_quantity > 0)
ORDER BY l.product_id,o.placed_at DESC,o.recorded_at DESC,o.id DESC,l.line_number DESC;

CREATE VIEW app.checkout_totals WITH (security_invoker = true) AS
SELECT checkout_id,sum(round(quantity*unit_price_nok,2)) AS total_nok
FROM app.checkout_lines GROUP BY checkout_id;

-- Free unit cells per cabinet: grid positions not covered by any bin.
-- Empty drawer slots are allowed; a spanning bin covers many unit cells.
CREATE VIEW app.cabinet_free_cells WITH (security_invoker = true) AS
SELECT c.id AS cabinet_id, g.inner_row, g.inner_col
FROM app.cabinets c
CROSS JOIN LATERAL (
  SELECT r AS inner_row, col AS inner_col
  FROM generate_series(1, c.inner_rows) r
  CROSS JOIN generate_series(1, c.inner_cols) col
) g
WHERE NOT c.is_archived AND NOT EXISTS (
  SELECT 1 FROM app.bins b
  WHERE b.cabinet_id = c.id
    AND g.inner_row >= b.inner_row AND g.inner_row::bigint < b.inner_row::bigint + b.row_span
    AND g.inner_col >= b.inner_col AND g.inner_col::bigint < b.inner_col::bigint + b.col_span
);

-- ---------- Guardrails and audit ----------
CREATE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_RECORD: %.%',TG_TABLE_SCHEMA,TG_TABLE_NAME; END $$;
CREATE FUNCTION app.audit_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old jsonb; v_new jsonb; v_row jsonb; v_key jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
  v_row := coalesce(v_new,v_old);
  IF v_row ? 'id' THEN v_key := jsonb_build_object('id',v_row->'id');
  ELSIF v_row ? 'product_id' THEN v_key := jsonb_build_object('product_id',v_row->'product_id','attribute_id',v_row->'attribute_id');
  ELSE v_key := jsonb_build_object('code',v_row->'code'); END IF;
  INSERT INTO app.audit_log(table_name,row_key,action,before_data,after_data,actor_id,database_role)
  VALUES(TG_TABLE_NAME,v_key,TG_OP,v_old,v_new,app.current_staff_id(),
         coalesce(nullif(current_setting('role',true),'none'),session_user));
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE FUNCTION app.guard_help_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.edit_revision IS DISTINCT FROM OLD.edit_revision THEN
      RAISE EXCEPTION 'STALE_HELP_CONTACT';
    END IF;
    NEW.edit_revision := OLD.edit_revision + 1;
  ELSE NEW.edit_revision := 1; NEW.created_at := clock_timestamp(); END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER guard_help_contact BEFORE INSERT OR UPDATE ON app.help_contacts
FOR EACH ROW EXECUTE FUNCTION app.guard_help_contact();
CREATE FUNCTION app.guard_product() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_discrete boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.code,NEW.unit_code,NEW.stock_step,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.code,OLD.unit_code,OLD.stock_step,OLD.created_at) THEN
      RAISE EXCEPTION 'PRODUCT_IDENTITY_AND_STOCK_UNIT_ARE_IMMUTABLE';
    END IF;
    NEW.metadata_revision := OLD.metadata_revision + 1;
  ELSE NEW.metadata_revision := 1; NEW.created_at := clock_timestamp(); END IF;
  NEW.updated_at := clock_timestamp();
  SELECT is_discrete INTO v_discrete FROM app.units WHERE code = NEW.unit_code;
  IF v_discrete AND (mod(NEW.stock_step,1) <> 0 OR mod(NEW.sale_step,1) <> 0) THEN
    RAISE EXCEPTION 'DISCRETE_UNIT_REQUIRES_WHOLE_QUANTITIES';
  END IF;
  IF NEW.bin_id IS NOT NULL THEN
    -- Serialize assignment with retirement. Retiring a bin with any product
    -- still assigned is rejected, including inactive products.
    PERFORM 1 FROM app.bins WHERE id=NEW.bin_id AND NOT is_archived FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_BIN_UNAVAILABLE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_product BEFORE INSERT OR UPDATE ON app.products
FOR EACH ROW EXECUTE FUNCTION app.guard_product();
CREATE FUNCTION app.guard_attribute_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id,NEW.code,NEW.value_type,NEW.canonical_unit)
     IS DISTINCT FROM (OLD.id,OLD.code,OLD.value_type,OLD.canonical_unit) THEN
    RAISE EXCEPTION 'ATTRIBUTE_MEANING_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_attribute_definition BEFORE UPDATE ON app.attribute_definitions
FOR EACH ROW EXECUTE FUNCTION app.guard_attribute_definition();
CREATE FUNCTION app.guard_attribute_value() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type text;
BEGIN
  SELECT value_type INTO STRICT v_type FROM app.attribute_definitions WHERE id=NEW.attribute_id;
  IF (v_type='number' AND NEW.number_value IS NULL)
     OR (v_type='text' AND NEW.text_value IS NULL)
     OR (v_type='boolean' AND NEW.boolean_value IS NULL) THEN
    RAISE EXCEPTION 'ATTRIBUTE_VALUE_TYPE_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_attribute_value BEFORE INSERT OR UPDATE ON app.product_attributes
FOR EACH ROW EXECUTE FUNCTION app.guard_attribute_value();

-- Bins must fit inside their cabinet grid and must not overlap another bin
-- in the same cabinet. Checked as a deferrable constraint trigger so a
-- two-bin swap in one statement is validated on its final positions,
-- not on the intermediate state where both briefly claim one spot.
-- The trigger locks the affected cabinet row(s) so concurrent placements
-- into the same cabinet serialize: without the lock two overlapping
-- INSERTs could both pass the EXISTS check before either commits.
CREATE FUNCTION app.guard_bin_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_read_committed();
  IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'STORAGE_IDENTITY_IS_IMMUTABLE';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.row_span,NEW.col_span) IS DISTINCT FROM (OLD.row_span,OLD.col_span)
     AND EXISTS (SELECT 1 FROM app.products WHERE bin_id=NEW.id)
     AND ((NEW.cabinet_id,NEW.inner_row,NEW.inner_col) IS DISTINCT FROM (OLD.cabinet_id,OLD.inner_row,OLD.inner_col)
       OR NEW.row_span<OLD.row_span OR NEW.col_span<OLD.col_span) THEN
    RAISE EXCEPTION 'LAYOUT_HAS_PRODUCTS';
  END IF;
  IF NEW.is_archived THEN
    IF EXISTS (SELECT 1 FROM app.products WHERE bin_id=NEW.id) THEN
      RAISE EXCEPTION 'BIN_STILL_HAS_PRODUCTS';
    END IF;
    -- The audited OLD row keeps the previous physical placement.
    NEW.cabinet_id := NULL; NEW.inner_row := NULL; NEW.inner_col := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_bin_archive BEFORE INSERT OR UPDATE ON app.bins
FOR EACH ROW EXECUTE FUNCTION app.guard_bin_archive();

CREATE FUNCTION app.check_bin_placement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows integer; v_cols integer;
BEGIN
  -- A row lock does not refresh a REPEATABLE READ snapshot of sibling bins.
  PERFORM app.require_read_committed();
  IF NEW.is_archived THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.cabinet_id IS DISTINCT FROM NEW.cabinet_id THEN
    PERFORM 1 FROM app.cabinets
      WHERE id IN (OLD.cabinet_id, NEW.cabinet_id) ORDER BY id FOR UPDATE;
  ELSE
    PERFORM 1 FROM app.cabinets WHERE id = NEW.cabinet_id FOR UPDATE;
  END IF;
  SELECT inner_rows, inner_cols INTO STRICT v_rows, v_cols
    FROM app.cabinets WHERE id = NEW.cabinet_id;
  IF EXISTS (SELECT 1 FROM app.cabinets WHERE id=NEW.cabinet_id AND is_archived) THEN
    RAISE EXCEPTION 'CABINET_ARCHIVED';
  END IF;
  IF NEW.inner_row::bigint + NEW.row_span - 1 > v_rows
     OR NEW.inner_col::bigint + NEW.col_span - 1 > v_cols THEN
    RAISE EXCEPTION 'BIN_DOES_NOT_FIT_CABINET_GRID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.bins b
    WHERE b.cabinet_id = NEW.cabinet_id AND b.id <> NEW.id AND NOT b.is_archived
      AND NEW.inner_row::bigint < b.inner_row::bigint + b.row_span
      AND b.inner_row::bigint < NEW.inner_row::bigint + NEW.row_span
      AND NEW.inner_col::bigint < b.inner_col::bigint + b.col_span
      AND b.inner_col::bigint < NEW.inner_col::bigint + NEW.col_span
  ) THEN
    RAISE EXCEPTION 'BIN_POSITION_OCCUPIED';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER bin_no_overlap
  AFTER INSERT OR UPDATE ON app.bins
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION app.check_bin_placement();

-- Shrinking a cabinet grid below bins it already holds is rejected.
CREATE FUNCTION app.guard_cabinet_shrink() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_read_committed();
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'STORAGE_IDENTITY_IS_IMMUTABLE';
  END IF;
  IF NEW.is_archived THEN
    IF EXISTS (SELECT 1 FROM app.bins WHERE cabinet_id=NEW.id AND NOT is_archived) THEN
      RAISE EXCEPTION 'CABINET_STILL_HAS_BINS';
    END IF;
    NEW.outer_row := NULL; NEW.outer_col := NULL;
  END IF;
  IF NEW.inner_rows < OLD.inner_rows OR NEW.inner_cols < OLD.inner_cols THEN
    IF EXISTS (
      SELECT 1 FROM app.bins b
      WHERE b.cabinet_id = NEW.id
        AND (b.inner_row::bigint + b.row_span - 1 > NEW.inner_rows
             OR b.inner_col::bigint + b.col_span - 1 > NEW.inner_cols)
    ) THEN
      RAISE EXCEPTION 'CABINET_SHRINK_WOULD_ORPHAN_BINS';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_cabinet_shrink BEFORE UPDATE ON app.cabinets
FOR EACH ROW EXECUTE FUNCTION app.guard_cabinet_shrink();

CREATE FUNCTION app.guard_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text;
BEGIN
  SELECT kind INTO STRICT v_kind FROM app.inventory_events WHERE id=NEW.event_id;
  PERFORM app.validate_quantity(NEW.product_id,NEW.quantity_delta,false,true);
  IF (v_kind='receipt' AND NEW.quantity_delta <= 0)
     OR (v_kind IN ('sale','withdrawal') AND NEW.quantity_delta >= 0) THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT_SIGN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_movement BEFORE INSERT ON app.inventory_movements
FOR EACH ROW EXECUTE FUNCTION app.guard_movement();

CREATE FUNCTION app.guard_correction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_product uuid; v_original_product uuid; v_kind text;
BEGIN
  SELECT m.product_id,e.kind INTO STRICT v_product,v_kind
    FROM app.inventory_movements m JOIN app.inventory_events e ON e.id=m.event_id
    WHERE m.id=NEW.movement_id;
  SELECT product_id INTO v_original_product FROM app.inventory_movements WHERE id=NEW.corrects_movement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CORRECTED_MOVEMENT_NOT_FOUND: %',NEW.corrects_movement_id; END IF;
  IF v_product<>v_original_product OR v_kind<>'adjustment' THEN
    RAISE EXCEPTION 'INVALID_CORRECTION_REFERENCE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_correction BEFORE INSERT ON app.movement_corrections
FOR EACH ROW EXECUTE FUNCTION app.guard_correction();
CREATE FUNCTION app.guard_receipt_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m app.inventory_movements%ROWTYPE; v_product uuid; v_kind text;
BEGIN
  SELECT * INTO STRICT m FROM app.inventory_movements WHERE id=NEW.movement_id;
  SELECT product_id INTO STRICT v_product FROM app.purchase_order_lines WHERE id=NEW.order_line_id;
  SELECT kind INTO STRICT v_kind FROM app.inventory_events WHERE id=m.event_id;
  IF m.product_id <> v_product OR v_kind NOT IN ('receipt','adjustment') THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_ALLOCATION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_receipt_allocation BEFORE INSERT ON app.receipt_allocations
FOR EACH ROW EXECUTE FUNCTION app.guard_receipt_allocation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_events','inventory_movements','movement_corrections','receipt_allocations',
     'checkouts','checkout_lines','sales','stock_counts','purchase_order_cancellations','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()',t);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_members','help_contacts','units','categories','cabinets','bins','products',
     'attribute_definitions','product_attributes','purchase_orders','purchase_order_lines','count_batches'] LOOP
    EXECUTE format('CREATE TRIGGER audit_metadata AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.audit_metadata()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_members','help_contacts','units','categories','cabinets','bins','products',
     'attribute_definitions','purchase_orders','purchase_order_lines','count_batches'] LOOP
    EXECUTE format('CREATE TRIGGER keep_records BEFORE DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()',t);
  END LOOP;
END $$;

CREATE FUNCTION app.guard_purchase_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='UPDATE' AND
    (NEW.id,NEW.order_id,NEW.line_number,NEW.product_id,NEW.ordered_quantity)
    IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.line_number,OLD.product_id,OLD.ordered_quantity) THEN
    RAISE EXCEPTION 'ORDER_LINE_IDENTITY_AND_ORDERED_QUANTITY_ARE_IMMUTABLE';
  END IF;
  PERFORM app.validate_quantity(NEW.product_id,NEW.ordered_quantity);
  RETURN NEW;
END $$;
CREATE TRIGGER guard_purchase_line BEFORE INSERT OR UPDATE ON app.purchase_order_lines
FOR EACH ROW EXECUTE FUNCTION app.guard_purchase_line();

-- A layout is saved as one command: stable drawer identities are generated by
-- the client from its grid and carried unchanged in retries. Positions are the
-- displayed addresses; identities only keep products attached to physical drawers.
CREATE FUNCTION public.amp_save_shelf_layout(
  p_request_id uuid,p_before jsonb,p_cabinet jsonb,p_before_bins jsonb,p_bins jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.require_staff(); v_cached jsonb;
  v_cabinet app.cabinets%ROWTYPE; v_current app.cabinets%ROWTYPE;
  v_bins jsonb; v_before_bins jsonb; v_value jsonb; v_key text; v_is_cabinet boolean;
  v_keys text[]; v_coordinates text[]; v_ids uuid[];
BEGIN
  v_cached := app.begin_command(p_request_id,'save_shelf_layout',v_actor,
    jsonb_build_object('before',p_before,'cabinet',p_cabinet,'before_bins',p_before_bins,'bins',p_bins));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF jsonb_typeof(p_cabinet) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_before_bins) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_bins) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  IF jsonb_array_length(p_before_bins)>4096 OR jsonb_array_length(p_bins)>4096 THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  -- Do not let jsonb_populate_record coerce strings, booleans or fractional
  -- coordinates into apparently valid records. The JSON boundary is exact.
  FOR v_value,v_is_cabinet IN SELECT p_cabinet,true UNION ALL SELECT value,false FROM jsonb_array_elements(p_bins) LOOP
    IF v_is_cabinet THEN
      v_keys := ARRAY['id','code','label','outer_row','outer_col','inner_rows','inner_cols','is_archived'];
      v_coordinates := ARRAY['outer_row','outer_col','inner_rows','inner_cols'];
    ELSE
      v_keys := ARRAY['id','code','label','cabinet_id','inner_row','inner_col','row_span','col_span','is_archived'];
      v_coordinates := ARRAY['inner_row','inner_col','row_span','col_span'];
    END IF;
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_SHELF_LAYOUT'; END IF;
    IF NOT v_value ?& v_keys OR (SELECT count(*) FROM jsonb_object_keys(v_value))<>cardinality(v_keys)
       OR jsonb_typeof(v_value->'id') IS DISTINCT FROM 'string'
       OR (v_value->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_value->'code') IS DISTINCT FROM 'string'
       OR length(btrim(v_value->>'code')) NOT BETWEEN 1 AND 64
       OR jsonb_typeof(v_value->'label') NOT IN ('string','null')
       OR v_value->'is_archived' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
    END IF;
    FOREACH v_key IN ARRAY v_coordinates LOOP
      IF jsonb_typeof(v_value->v_key) IS DISTINCT FROM 'number'
         OR (v_value->>v_key) !~ '^[1-9][0-9]{0,9}$' THEN
        RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
      END IF;
      IF (v_value->>v_key)::numeric > 2147483647 THEN RAISE EXCEPTION 'INVALID_SHELF_LAYOUT'; END IF;
    END LOOP;
    IF NOT v_is_cabinet AND v_value->'cabinet_id' IS DISTINCT FROM p_cabinet->'id' THEN
      RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
    END IF;
  END LOOP;
  SELECT * INTO v_cabinet FROM jsonb_populate_record(NULL::app.cabinets,p_cabinet);
  IF v_cabinet.inner_rows::bigint*v_cabinet.inner_cols>4096 THEN RAISE EXCEPTION 'INVALID_SHELF_LAYOUT'; END IF;
  SELECT coalesce(array_agg(id),ARRAY[]::uuid[]) INTO v_ids FROM jsonb_populate_recordset(NULL::app.bins,p_bins);
  IF cardinality(v_ids)<>(SELECT count(DISTINCT id) FROM unnest(v_ids) id)
     OR jsonb_array_length(p_bins)<>(SELECT count(DISTINCT value->>'code') FROM jsonb_array_elements(p_bins))
     OR EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::app.bins,p_bins) b
       WHERE b.inner_row::bigint+b.row_span-1>v_cabinet.inner_rows
          OR b.inner_col::bigint+b.col_span-1>v_cabinet.inner_cols)
     OR EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::app.bins,p_bins) a
       JOIN jsonb_populate_recordset(NULL::app.bins,p_bins) b ON a.id<b.id
        AND a.inner_row::bigint<b.inner_row::bigint+b.row_span AND b.inner_row::bigint<a.inner_row::bigint+a.row_span
        AND a.inner_col::bigint<b.inner_col::bigint+b.col_span AND b.inner_col::bigint<a.inner_col::bigint+a.col_span) THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  -- Bins precede cabinets, matching move/swap and assignment/retirement locks.
  -- Include current rows plus the submitted snapshot IDs: a moved drawer must
  -- cause a stale result, never be pulled back into the old cabinet.
  PERFORM 1 FROM app.bins b
    WHERE (b.cabinet_id=v_cabinet.id AND NOT b.is_archived)
       OR b.id::text IN (SELECT value->>'id' FROM jsonb_array_elements(p_before_bins))
    ORDER BY b.id FOR UPDATE;
  SELECT * INTO v_current FROM app.cabinets WHERE id=v_cabinet.id FOR UPDATE;
  IF nullif(p_before,'null'::jsonb) IS NULL THEN
    IF v_current.id IS NOT NULL OR p_before_bins<>'[]'::jsonb THEN RAISE EXCEPTION 'STALE_SHELF_LAYOUT'; END IF;
  ELSIF to_jsonb(v_current) IS DISTINCT FROM p_before
        OR p_before->'id' IS DISTINCT FROM p_cabinet->'id'
        OR p_before->'code' IS DISTINCT FROM p_cabinet->'code' THEN
    RAISE EXCEPTION 'STALE_SHELF_LAYOUT';
  END IF;
  -- An insertion can finish while we wait for the cabinet lock. Re-read all
  -- live bins only after that wait; an earlier snapshot cannot prove freshness.
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb) INTO v_bins
    FROM app.bins b WHERE b.cabinet_id=v_cabinet.id AND NOT b.is_archived;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb) INTO v_before_bins
    FROM jsonb_array_elements(p_before_bins);
  IF v_bins IS DISTINCT FROM v_before_bins THEN RAISE EXCEPTION 'STALE_SHELF_LAYOUT'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::app.bins,p_bins) n JOIN app.bins b ON b.id=n.id
    WHERE b.cabinet_id IS DISTINCT FROM v_cabinet.id OR b.is_archived OR b.code<>n.code) THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  IF EXISTS (SELECT 1 FROM app.bins b
    LEFT JOIN jsonb_populate_recordset(NULL::app.bins,p_bins) n ON n.id=b.id
    WHERE b.cabinet_id=v_cabinet.id AND NOT b.is_archived
      AND (n.id IS NULL OR (b.inner_row,b.inner_col) IS DISTINCT FROM (n.inner_row,n.inner_col)
        OR n.row_span<b.row_span OR n.col_span<b.col_span)
      AND EXISTS (SELECT 1 FROM app.products WHERE bin_id=b.id)) THEN
    RAISE EXCEPTION 'LAYOUT_HAS_PRODUCTS';
  END IF;
  -- An occupied drawer can grow at its original anchor by consuming whole,
  -- unassigned neighbours. It cannot split or move a neighbour out of its way.
  IF EXISTS (SELECT 1 FROM app.bins b
    JOIN jsonb_populate_recordset(NULL::app.bins,p_bins) n ON n.id=b.id
    JOIN app.bins neighbour ON neighbour.cabinet_id=b.cabinet_id AND NOT neighbour.is_archived AND neighbour.id<>b.id
      AND n.inner_row::bigint<neighbour.inner_row::bigint+neighbour.row_span
      AND neighbour.inner_row::bigint<n.inner_row::bigint+n.row_span
      AND n.inner_col::bigint<neighbour.inner_col::bigint+neighbour.col_span
      AND neighbour.inner_col::bigint<n.inner_col::bigint+n.col_span
    WHERE b.cabinet_id=v_cabinet.id AND NOT b.is_archived
      AND (b.row_span,b.col_span) IS DISTINCT FROM (n.row_span,n.col_span)
      AND EXISTS (SELECT 1 FROM app.products WHERE bin_id=b.id)
      AND (neighbour.inner_row<n.inner_row OR neighbour.inner_col<n.inner_col
        OR neighbour.inner_row::bigint+neighbour.row_span>n.inner_row::bigint+n.row_span
        OR neighbour.inner_col::bigint+neighbour.col_span>n.inner_col::bigint+n.col_span
        OR neighbour.id=ANY(v_ids))) THEN
    RAISE EXCEPTION 'INVALID_SHELF_LAYOUT';
  END IF;
  IF v_current.id IS NULL THEN
    INSERT INTO app.cabinets SELECT v_cabinet.*;
  ELSE
    -- Grow before placing drawers, then shrink after their final positions.
    -- Every intermediate statement satisfies the ordinary placement triggers.
    UPDATE app.cabinets SET outer_row=v_cabinet.outer_row,outer_col=v_cabinet.outer_col,
      inner_rows=greatest(inner_rows,v_cabinet.inner_rows),inner_cols=greatest(inner_cols,v_cabinet.inner_cols),
      label=v_cabinet.label,is_archived=false WHERE id=v_cabinet.id
      AND (outer_row,outer_col,inner_rows,inner_cols,label,is_archived) IS DISTINCT FROM
        (v_cabinet.outer_row,v_cabinet.outer_col,greatest(inner_rows,v_cabinet.inner_rows),
         greatest(inner_cols,v_cabinet.inner_cols),v_cabinet.label,false);
  END IF;
  UPDATE app.bins SET is_archived=true WHERE cabinet_id=v_cabinet.id AND NOT is_archived AND NOT id=ANY(v_ids);
  UPDATE app.bins b SET inner_row=n.inner_row,inner_col=n.inner_col,row_span=n.row_span,col_span=n.col_span,
    label=n.label FROM jsonb_populate_recordset(NULL::app.bins,p_bins) n
    WHERE b.id=n.id AND b.id::text IN (SELECT value->>'id' FROM jsonb_array_elements(v_bins))
      AND to_jsonb(b) IS DISTINCT FROM to_jsonb(n);
  INSERT INTO app.bins SELECT n.* FROM jsonb_populate_recordset(NULL::app.bins,p_bins) n
    WHERE n.id::text NOT IN (SELECT value->>'id' FROM jsonb_array_elements(v_bins));
  UPDATE app.cabinets SET inner_rows=v_cabinet.inner_rows,inner_cols=v_cabinet.inner_cols
    WHERE id=v_cabinet.id AND (inner_rows,inner_cols) IS DISTINCT FROM (v_cabinet.inner_rows,v_cabinet.inner_cols);
  RETURN app.finish_command(p_request_id,jsonb_build_object('cabinet_id',v_cabinet.id,'saved',true));
END $$;

-- Swap two occupied bins in one statement. Positions are (cabinet, row, col)
-- plus the spans shown on screen; spans travel with the bin. The deferrable
-- overlap trigger validates the final positions at statement end, so the
-- intermediate state where both briefly claim one spot cannot commit.
-- Moves into empty cells need no RPC:
-- UPDATE app.bins SET ... WHERE id=... AND cabinet_id=<shown> AND
-- inner_row=<shown> AND inner_col=<shown>, requiring exactly one row.
CREATE FUNCTION public.amp_swap_bins(
  p_request_id uuid,p_first_bin_id uuid,p_second_bin_id uuid,
  p_expected_first_cabinet_id uuid,p_expected_first_inner_row integer,p_expected_first_inner_col integer,
  p_expected_first_row_span integer,p_expected_first_col_span integer,
  p_expected_second_cabinet_id uuid,p_expected_second_inner_row integer,p_expected_second_inner_col integer,
  p_expected_second_row_span integer,p_expected_second_col_span integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
  a app.bins%ROWTYPE; b app.bins%ROWTYPE;
BEGIN
  v_cached := app.begin_command(p_request_id,'swap_bins',v_actor,
    jsonb_build_object('first',p_first_bin_id,'second',p_second_bin_id,
      'first_cabinet',p_expected_first_cabinet_id,'first_row',p_expected_first_inner_row,'first_col',p_expected_first_inner_col,
      'first_row_span',p_expected_first_row_span,'first_col_span',p_expected_first_col_span,
      'second_cabinet',p_expected_second_cabinet_id,'second_row',p_expected_second_inner_row,'second_col',p_expected_second_inner_col,
      'second_row_span',p_expected_second_row_span,'second_col_span',p_expected_second_col_span));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_first_bin_id IS NULL OR p_second_bin_id IS NULL OR p_first_bin_id=p_second_bin_id
     OR p_expected_first_cabinet_id IS NULL OR p_expected_second_cabinet_id IS NULL
     OR p_expected_first_inner_row IS NULL OR p_expected_first_inner_col IS NULL
     OR p_expected_first_row_span IS NULL OR p_expected_first_col_span IS NULL
     OR p_expected_second_inner_row IS NULL OR p_expected_second_inner_col IS NULL
     OR p_expected_second_row_span IS NULL OR p_expected_second_col_span IS NULL THEN
    RAISE EXCEPTION 'TWO_DISTINCT_BINS_AND_POSITIONS_REQUIRED';
  END IF;
  PERFORM 1 FROM app.bins
    WHERE id IN (p_first_bin_id,p_second_bin_id) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM app.bins WHERE id=p_first_bin_id;
  SELECT * INTO b FROM app.bins WHERE id=p_second_bin_id;
  IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'BIN_NOT_FOUND'; END IF;
  IF a.is_archived OR b.is_archived THEN RAISE EXCEPTION 'BIN_ARCHIVED'; END IF;
  IF a.cabinet_id<>p_expected_first_cabinet_id OR a.inner_row<>p_expected_first_inner_row OR a.inner_col<>p_expected_first_inner_col
     OR a.row_span<>p_expected_first_row_span OR a.col_span<>p_expected_first_col_span
     OR b.cabinet_id<>p_expected_second_cabinet_id OR b.inner_row<>p_expected_second_inner_row OR b.inner_col<>p_expected_second_inner_col
     OR b.row_span<>p_expected_second_row_span OR b.col_span<>p_expected_second_col_span THEN
    RAISE EXCEPTION 'STALE_BIN_POSITION';
  END IF;
  UPDATE app.bins SET cabinet_id=CASE id
    WHEN p_first_bin_id THEN b.cabinet_id ELSE a.cabinet_id END,
    inner_row=CASE id WHEN p_first_bin_id THEN b.inner_row ELSE a.inner_row END,
    inner_col=CASE id WHEN p_first_bin_id THEN b.inner_col ELSE a.inner_col END
    WHERE id IN (p_first_bin_id,p_second_bin_id);
  RETURN app.finish_command(p_request_id,jsonb_build_object(
    'first_bin_id',p_first_bin_id,'first_cabinet_id',b.cabinet_id,
    'first_inner_row',b.inner_row,'first_inner_col',b.inner_col,
    'second_bin_id',p_second_bin_id,'second_cabinet_id',a.cabinet_id,
    'second_inner_row',a.inner_row,'second_inner_col',a.inner_col));
END $$;

-- Swap two cabinets (whole outer frames) in one statement. The deferrable
-- unique position constraint is checked at statement end.
CREATE FUNCTION public.amp_swap_cabinets(
  p_request_id uuid,p_first_cabinet_id uuid,p_second_cabinet_id uuid,
  p_expected_first_outer_row integer,p_expected_first_outer_col integer,
  p_expected_second_outer_row integer,p_expected_second_outer_col integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
  a app.cabinets%ROWTYPE; b app.cabinets%ROWTYPE;
BEGIN
  v_cached := app.begin_command(p_request_id,'swap_cabinets',v_actor,
    jsonb_build_object('first',p_first_cabinet_id,'second',p_second_cabinet_id,
      'first_row',p_expected_first_outer_row,'first_col',p_expected_first_outer_col,
      'second_row',p_expected_second_outer_row,'second_col',p_expected_second_outer_col));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_first_cabinet_id IS NULL OR p_second_cabinet_id IS NULL OR p_first_cabinet_id=p_second_cabinet_id
     OR p_expected_first_outer_row IS NULL OR p_expected_first_outer_col IS NULL
     OR p_expected_second_outer_row IS NULL OR p_expected_second_outer_col IS NULL THEN
    RAISE EXCEPTION 'TWO_DISTINCT_CABINETS_AND_POSITIONS_REQUIRED';
  END IF;
  PERFORM 1 FROM app.cabinets
    WHERE id IN (p_first_cabinet_id,p_second_cabinet_id) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM app.cabinets WHERE id=p_first_cabinet_id;
  SELECT * INTO b FROM app.cabinets WHERE id=p_second_cabinet_id;
  IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'CABINET_NOT_FOUND'; END IF;
  IF a.is_archived OR b.is_archived THEN RAISE EXCEPTION 'CABINET_ARCHIVED'; END IF;
  IF a.outer_row<>p_expected_first_outer_row OR a.outer_col<>p_expected_first_outer_col
     OR b.outer_row<>p_expected_second_outer_row OR b.outer_col<>p_expected_second_outer_col THEN
    RAISE EXCEPTION 'STALE_CABINET_POSITION';
  END IF;
  UPDATE app.cabinets SET
    outer_row=CASE id WHEN p_first_cabinet_id THEN b.outer_row ELSE a.outer_row END,
    outer_col=CASE id WHEN p_first_cabinet_id THEN b.outer_col ELSE a.outer_col END
    WHERE id IN (p_first_cabinet_id,p_second_cabinet_id);
  RETURN app.finish_command(p_request_id,jsonb_build_object(
    'first_cabinet_id',p_first_cabinet_id,
    'first_outer_row',b.outer_row,'first_outer_col',b.outer_col,
    'second_cabinet_id',p_second_cabinet_id,
    'second_outer_row',a.outer_row,'second_outer_col',a.outer_col));
END $$;

-- ---------- Placed orders and cancellations ----------
CREATE FUNCTION public.amp_record_order(
  p_request_id uuid, p_supplier_name text, p_placed_at timestamptz,
  p_items jsonb, p_additional_cost_nok numeric DEFAULT 0,
  p_supplier_reference text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_id uuid; r record;
BEGIN
  v_cached := app.begin_command(p_request_id,'record_order',v_actor,
    jsonb_build_object('supplier',p_supplier_name,'placed_at',p_placed_at,'items',p_items,
      'additional',p_additional_cost_nok,'reference',p_supplier_reference,'note',p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_placed_at IS NULL THEN RAISE EXCEPTION 'PLACED_AT_REQUIRED'; END IF;
  IF p_placed_at > clock_timestamp() + interval '1 day' THEN
    RAISE EXCEPTION 'ORDER_PLACED_IN_FUTURE';
  END IF;
  PERFORM app.check_items(p_items);
  PERFORM app.lock_products(ARRAY(SELECT (item.value->>'product_id')::uuid FROM jsonb_array_elements(p_items) AS item(value)));
  INSERT INTO app.purchase_orders(request_id,supplier_name,supplier_reference,placed_at,
      additional_cost_nok,note,created_by)
    VALUES(p_request_id,p_supplier_name,p_supplier_reference,p_placed_at,
      p_additional_cost_nok,p_note,v_actor) RETURNING id INTO v_id;
  FOR r IN SELECT value,ordinality FROM jsonb_array_elements(p_items) WITH ORDINALITY LOOP
    INSERT INTO app.purchase_order_lines(order_id,line_number,product_id,ordered_quantity,
      unit_cost_nok,purchase_url,supplier_sku)
    VALUES(v_id,r.ordinality::integer,(r.value->>'product_id')::uuid,
      (r.value->>'quantity')::numeric,(r.value->>'unit_cost_nok')::numeric,
      nullif(r.value->>'purchase_url',''),nullif(r.value->>'supplier_sku',''));
  END LOOP;
  RETURN app.finish_command(p_request_id,jsonb_build_object('order_id',v_id));
END $$;

CREATE FUNCTION public.amp_cancel_order_quantities(
  p_request_id uuid, p_order_id uuid, p_items jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; x jsonb;
  l app.purchase_line_progress%ROWTYPE; v_quantity app.quantity;
BEGIN
  v_cached := app.begin_command(p_request_id,'cancel_order_quantities',v_actor,
    jsonb_build_object('order',p_order_id,'items',p_items,'reason',p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.check_items(p_items);
  PERFORM 1 FROM app.purchase_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF (SELECT count(*)<>count(DISTINCT item.value->>'order_line_id') FROM jsonb_array_elements(p_items) AS item(value))
    THEN RAISE EXCEPTION 'DUPLICATE_OR_MISSING_ORDER_LINE'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO l FROM app.purchase_line_progress
      WHERE id=(x->>'order_line_id')::uuid AND order_id=p_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_LINE_NOT_FOUND: %',x->>'order_line_id'; END IF;
    v_quantity := (x->>'quantity')::numeric;
    PERFORM app.validate_quantity(l.product_id,v_quantity);
    IF v_quantity <= 0 OR v_quantity > l.outstanding_quantity THEN
      RAISE EXCEPTION 'INVALID_CANCELLATION_QUANTITY';
    END IF;
    INSERT INTO app.purchase_order_cancellations(request_id,order_line_id,quantity,reason,created_by)
      VALUES(p_request_id,l.id,v_quantity,p_reason,v_actor);
  END LOOP;
  RETURN app.finish_command(p_request_id,jsonb_build_object('order_id',p_order_id));
END $$;

CREATE FUNCTION public.amp_reverse_cancellation(p_request_id uuid,p_cancellation_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; c app.purchase_order_cancellations%ROWTYPE;
  v_order uuid; v_id uuid;
BEGIN
  v_cached := app.begin_command(p_request_id,'reverse_cancellation',v_actor,
    jsonb_build_object('cancellation',p_cancellation_id,'reason',p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  SELECT * INTO c FROM app.purchase_order_cancellations WHERE id=p_cancellation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCELLATION_NOT_FOUND'; END IF;
  IF c.reverses_id IS NOT NULL THEN RAISE EXCEPTION 'CANNOT_REVERSE_A_REVERSAL'; END IF;
  SELECT order_id INTO v_order FROM app.purchase_order_lines WHERE id=c.order_line_id;
  PERFORM 1 FROM app.purchase_orders WHERE id=v_order FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.purchase_order_cancellations WHERE reverses_id=c.id) THEN
    RAISE EXCEPTION 'CANCELLATION_ALREADY_REVERSED';
  END IF;
  INSERT INTO app.purchase_order_cancellations(request_id,order_line_id,quantity,reverses_id,reason,created_by)
    VALUES(p_request_id,c.order_line_id,c.quantity,c.id,p_reason,v_actor) RETURNING id INTO v_id;
  RETURN app.finish_command(p_request_id,jsonb_build_object('cancellation_id',v_id,'order_id',v_order));
END $$;

-- ---------- Receipts, adjustments and non-sale withdrawals ----------
CREATE FUNCTION public.amp_record_receipt(
  p_request_id uuid, p_items jsonb, p_purchase_order_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL, p_occurred_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_event uuid; x jsonb;
  v_product uuid; v_line uuid; v_quantity app.quantity; v_movement bigint;
  l app.purchase_line_progress%ROWTYPE;
BEGIN
  v_cached := app.begin_command(p_request_id,'record_receipt',v_actor,
    jsonb_build_object('items',p_items,'order',p_purchase_order_id,'note',p_note,'occurred_at',p_occurred_at));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.check_items(p_items);
  IF p_purchase_order_id IS NOT NULL THEN
    PERFORM 1 FROM app.purchase_orders WHERE id=p_purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  ELSIF p_note IS NULL OR length(btrim(p_note))=0 THEN
    RAISE EXCEPTION 'UNPLANNED_RECEIPT_REQUIRES_SOURCE_NOTE';
  END IF;
  PERFORM app.lock_products(ARRAY(SELECT (item.value->>'product_id')::uuid FROM jsonb_array_elements(p_items) AS item(value)));
  INSERT INTO app.inventory_events(request_id,kind,actor_id,purchase_order_id,note,occurred_at)
    VALUES(p_request_id,'receipt',v_actor,p_purchase_order_id,p_note,coalesce(p_occurred_at,clock_timestamp()))
    RETURNING id INTO v_event;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_product := (x->>'product_id')::uuid; v_quantity := (x->>'quantity')::numeric;
    v_line := (x->>'order_line_id')::uuid;
    PERFORM app.validate_quantity(v_product,v_quantity);
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'POSITIVE_RECEIPT_QUANTITY_REQUIRED'; END IF;
    IF p_purchase_order_id IS NOT NULL THEN
      IF v_line IS NULL THEN RAISE EXCEPTION 'RECEIPT_ORDER_LINE_REQUIRED'; END IF;
      SELECT * INTO l FROM app.purchase_line_progress WHERE id=v_line;
      IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_LINE_NOT_FOUND: %',v_line; END IF;
      IF l.order_id<>p_purchase_order_id OR l.product_id<>v_product THEN
        RAISE EXCEPTION 'RECEIPT_ORDER_LINE_MISMATCH';
      END IF;
      IF v_quantity>l.outstanding_quantity THEN
        RAISE EXCEPTION 'RECEIPT_EXCEEDS_OUTSTANDING_QUANTITY';
      END IF;
    ELSIF v_line IS NOT NULL THEN RAISE EXCEPTION 'UNPLANNED_RECEIPT_CANNOT_HAVE_ORDER_LINE';
    END IF;
    INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
      VALUES(v_event,v_product,v_quantity) RETURNING id INTO v_movement;
    IF v_line IS NOT NULL THEN
      INSERT INTO app.receipt_allocations VALUES(v_movement,v_line);
    END IF;
  END LOOP;
  RETURN app.finish_command(p_request_id,jsonb_build_object('event_id',v_event));
END $$;

CREATE FUNCTION app.post_manual(
  p_request_id uuid,p_kind text,p_items jsonb,p_reason text,p_recount boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_event uuid; x jsonb;
  v_product uuid; v_delta app.quantity; v_original bigint; v_new bigint;
  v_order uuid; v_line uuid; l app.purchase_line_progress%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('adjustment','withdrawal') THEN RAISE EXCEPTION 'INVALID_MANUAL_KIND'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason))=0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  v_cached := app.begin_command(p_request_id,p_kind,v_actor,
    jsonb_build_object('items',p_items,'reason',p_reason,'recount',p_recount));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.check_items(p_items);
  -- Receipt corrections must serialise with receipts and cancellations too.
  FOR v_order IN
    SELECT DISTINCT ol.order_id FROM jsonb_array_elements(p_items) AS item(value)
    JOIN app.receipt_allocations a ON a.movement_id=(item.value->>'corrects_movement_id')::bigint
    JOIN app.purchase_order_lines ol ON ol.id=a.order_line_id ORDER BY ol.order_id
  LOOP PERFORM 1 FROM app.purchase_orders WHERE id=v_order FOR UPDATE; END LOOP;
  PERFORM app.lock_products(ARRAY(SELECT (item.value->>'product_id')::uuid FROM jsonb_array_elements(p_items) AS item(value)));
  -- Validate all observations before adding any movement from this command.
  -- Two different request IDs can still represent the same stale intention.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS item(value)
    WHERE item.value->>'corrects_movement_id' IS NOT NULL
    GROUP BY (item.value->>'corrects_movement_id')::bigint HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'DUPLICATE_CORRECTION_REFERENCE'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items)
           WHERE value->>'corrects_movement_id' IS NOT NULL LOOP
    IF x->>'expected_revision' IS NULL THEN
      RAISE EXCEPTION 'CORRECTION_REVISION_REQUIRED';
    END IF;
    IF (x->>'expected_revision')::bigint IS DISTINCT FROM
       (SELECT revision FROM app.inventory WHERE product_id=(x->>'product_id')::uuid) THEN
      RAISE EXCEPTION 'STALE_STOCK_CORRECTION';
    END IF;
    IF NOT p_recount AND EXISTS (
      SELECT 1 FROM app.stock_counts
      WHERE product_id=(x->>'product_id')::uuid
        AND expected_revision >= (x->>'corrects_movement_id')::bigint
    ) THEN
      RAISE EXCEPTION 'CORRECTION_REQUIRES_RECOUNT';
    END IF;
  END LOOP;
  INSERT INTO app.inventory_events(request_id,kind,actor_id,note)
    VALUES(p_request_id,p_kind,v_actor,p_reason) RETURNING id INTO v_event;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_product := (x->>'product_id')::uuid;
    v_original := (x->>'corrects_movement_id')::bigint;
    IF p_kind='withdrawal' THEN
      v_delta := -(x->>'quantity')::numeric;
      IF v_delta >= 0 OR v_original IS NOT NULL THEN RAISE EXCEPTION 'INVALID_WITHDRAWAL'; END IF;
    ELSE v_delta := (x->>'quantity_delta')::numeric; END IF;
    PERFORM app.validate_quantity(v_product,v_delta);
    INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
      VALUES(v_event,v_product,v_delta) RETURNING id INTO v_new;
    IF v_original IS NOT NULL THEN
      INSERT INTO app.movement_corrections VALUES(v_new,v_original);
    END IF;
    v_line := NULL;
    SELECT order_line_id INTO v_line FROM app.receipt_allocations WHERE movement_id=v_original;
    IF v_line IS NOT NULL THEN
      INSERT INTO app.receipt_allocations VALUES(v_new,v_line);
      SELECT * INTO STRICT l FROM app.purchase_line_progress WHERE id=v_line;
      IF l.received_quantity<0 OR l.received_quantity+l.cancelled_quantity>l.ordered_quantity THEN
        RAISE EXCEPTION 'RECEIPT_CORRECTION_OUT_OF_RANGE';
      END IF;
    END IF;
  END LOOP;
  RETURN app.finish_command(p_request_id,jsonb_build_object('event_id',v_event));
END $$;
CREATE FUNCTION public.amp_adjust_stock(p_request_id uuid,p_items jsonb,p_reason text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.post_manual(p_request_id,'adjustment',p_items,p_reason)
$$;
CREATE FUNCTION public.amp_withdraw_stock(p_request_id uuid,p_items jsonb,p_reason text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.post_manual(p_request_id,'withdrawal',p_items,p_reason)
$$;

-- ---------- Count batches; each count commits immediately ----------
CREATE FUNCTION public.amp_start_count_batch(p_request_id uuid,p_title text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_id uuid;
BEGIN
  v_cached := app.begin_command(p_request_id,'start_count_batch',v_actor,jsonb_build_object('title',p_title));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  INSERT INTO app.count_batches(request_id,owner_id,title)
    VALUES(p_request_id,v_actor,p_title) RETURNING id INTO v_id;
  RETURN app.finish_command(p_request_id,jsonb_build_object('batch_id',v_id));
END $$;
CREATE FUNCTION public.amp_record_count(
  p_request_id uuid,p_batch_id uuid,p_product_id uuid,
  p_expected_revision bigint,p_counted_quantity numeric,p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; b app.count_batches%ROWTYPE;
  v_quantity numeric; v_revision bigint; v_event uuid; v_delta numeric;
BEGIN
  v_cached := app.begin_command(p_request_id,'record_count',v_actor,
    jsonb_build_object('batch',p_batch_id,'product',p_product_id,'revision',p_expected_revision,
      'counted',p_counted_quantity,'note',p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  SELECT * INTO b FROM app.count_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COUNT_BATCH_NOT_FOUND'; END IF;
  IF b.owner_id<>v_actor THEN RAISE EXCEPTION 'COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER'; END IF;
  IF b.finished_at IS NOT NULL THEN RAISE EXCEPTION 'COUNT_BATCH_FINISHED'; END IF;
  PERFORM app.lock_products(ARRAY[p_product_id]);
  PERFORM app.validate_quantity(p_product_id,p_counted_quantity,false,true);
  IF p_counted_quantity<0 THEN RAISE EXCEPTION 'NEGATIVE_PHYSICAL_COUNT'; END IF;
  SELECT quantity,revision INTO STRICT v_quantity,v_revision FROM app.inventory WHERE product_id=p_product_id;
  IF p_expected_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'STALE_STOCK_COUNT'; END IF;
  INSERT INTO app.inventory_events(request_id,kind,actor_id,note)
    VALUES(p_request_id,'count',v_actor,p_note) RETURNING id INTO v_event;
  INSERT INTO app.stock_counts(event_id,batch_id,product_id,expected_quantity,counted_quantity,expected_revision)
    VALUES(v_event,p_batch_id,p_product_id,v_quantity,p_counted_quantity,v_revision);
  v_delta := p_counted_quantity-v_quantity;
  IF v_delta <> 0 THEN
    INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta) VALUES(v_event,p_product_id,v_delta);
  END IF;
  RETURN app.finish_command(p_request_id,
    jsonb_build_object('event_id',v_event,'quantity',p_counted_quantity::text,'difference',v_delta::text));
END $$;
-- Ad-hoc single-product count: creates its own finished batch, so staff never
-- open a batch just to correct one item they hold in their hand. The batch row
-- is preserved for audit; grouped stocktakes still use start/record/finish.
CREATE FUNCTION public.amp_record_single_count(
  p_request_id uuid,p_product_id uuid,
  p_expected_revision bigint,p_counted_quantity numeric,p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
  v_quantity numeric; v_revision bigint; v_event uuid; v_delta numeric;
  v_batch uuid; v_code text; v_now timestamptz;
BEGIN
  v_cached := app.begin_command(p_request_id,'record_single_count',v_actor,
    jsonb_build_object('product',p_product_id,'revision',p_expected_revision,
      'counted',p_counted_quantity,'note',p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.lock_products(ARRAY[p_product_id]);
  PERFORM app.validate_quantity(p_product_id,p_counted_quantity,false,true);
  IF p_counted_quantity<0 THEN RAISE EXCEPTION 'NEGATIVE_PHYSICAL_COUNT'; END IF;
  SELECT quantity,revision INTO STRICT v_quantity,v_revision FROM app.inventory WHERE product_id=p_product_id;
  IF p_expected_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'STALE_STOCK_COUNT'; END IF;
  SELECT code INTO STRICT v_code FROM app.products WHERE id=p_product_id;
  v_now := clock_timestamp();
  INSERT INTO app.count_batches(request_id,owner_id,title,started_at,finished_at,finished_by)
    VALUES(p_request_id,v_actor,'Single count '||v_code,v_now,v_now,v_actor) RETURNING id INTO v_batch;
  INSERT INTO app.inventory_events(request_id,kind,actor_id,note)
    VALUES(p_request_id,'count',v_actor,p_note) RETURNING id INTO v_event;
  INSERT INTO app.stock_counts(event_id,batch_id,product_id,expected_quantity,counted_quantity,expected_revision)
    VALUES(v_event,v_batch,p_product_id,v_quantity,p_counted_quantity,v_revision);
  v_delta := p_counted_quantity-v_quantity;
  IF v_delta <> 0 THEN
    INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta) VALUES(v_event,p_product_id,v_delta);
  END IF;
  RETURN app.finish_command(p_request_id,
    jsonb_build_object('batch_id',v_batch,'event_id',v_event,
      'quantity',p_counted_quantity::text,'difference',v_delta::text));
END $$;
-- A later count may already have absorbed the original mistake. Correct the
-- history and immediately recount in one transaction, without asking staff to
-- calculate an offset. Child commands remain attributable and the parent result
-- links both events; retrying the parent never starts new child commands.
CREATE FUNCTION public.amp_correct_movement_and_count(
  p_request_id uuid,p_corrects_movement_id bigint,p_expected_revision bigint,
  p_quantity_delta numeric,p_counted_quantity numeric,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_product uuid;
  v_order uuid; v_adjustment jsonb; v_count jsonb; v_revision bigint;
BEGIN
  v_cached := app.begin_command(p_request_id,'correct_movement_and_count',v_actor,
    jsonb_build_object('movement',p_corrects_movement_id,'revision',p_expected_revision,
      'delta',p_quantity_delta,'counted',p_counted_quantity,'reason',p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT product_id INTO v_product FROM app.inventory_movements WHERE id=p_corrects_movement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CORRECTED_MOVEMENT_NOT_FOUND'; END IF;
  SELECT l.order_id INTO v_order FROM app.receipt_allocations a
    JOIN app.purchase_order_lines l ON l.id=a.order_line_id WHERE a.movement_id=p_corrects_movement_id;
  IF v_order IS NOT NULL THEN
    PERFORM 1 FROM app.purchase_orders WHERE id=v_order FOR UPDATE;
  END IF;
  PERFORM app.lock_products(ARRAY[v_product]);
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=v_product;
  IF p_expected_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'STALE_STOCK_COUNT'; END IF;
  PERFORM app.validate_quantity(v_product,p_counted_quantity,false,true);
  IF p_counted_quantity<0 THEN RAISE EXCEPTION 'NEGATIVE_PHYSICAL_COUNT'; END IF;
  v_adjustment := app.post_manual(gen_random_uuid(),'adjustment',
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity_delta',p_quantity_delta::text,
      'corrects_movement_id',p_corrects_movement_id::text,'expected_revision',v_revision::text)),p_reason,true);
  SELECT revision INTO v_revision FROM app.inventory WHERE product_id=v_product;
  v_count := public.amp_record_single_count(gen_random_uuid(),v_product,v_revision,p_counted_quantity,p_reason);
  RETURN app.finish_command(p_request_id,jsonb_build_object(
    'correction_event_id',v_adjustment->>'event_id','count_event_id',v_count->>'event_id',
    'batch_id',v_count->>'batch_id','quantity',v_count->>'quantity'));
END $$;

CREATE FUNCTION public.amp_finish_count_batch(p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); b app.count_batches%ROWTYPE;
BEGIN
  SELECT * INTO b FROM app.count_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COUNT_BATCH_NOT_FOUND'; END IF;
  IF b.owner_id<>v_actor THEN RAISE EXCEPTION 'COUNT_BATCH_BELONGS_TO_ANOTHER_STAFF_MEMBER'; END IF;
  IF b.finished_at IS NULL THEN
    UPDATE app.count_batches SET finished_at=clock_timestamp(),finished_by=v_actor WHERE id=p_batch_id;
  END IF;
  RETURN jsonb_build_object('batch_id',p_batch_id,'finished',true);
END $$;

-- Active staff can close an abandoned batch only after its owner is disabled
-- or has lost their Auth account. Posted observations keep their original actor.
CREATE FUNCTION public.amp_close_abandoned_count_batch(
  p_request_id uuid,p_batch_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb;
  b app.count_batches%ROWTYPE; v_owner app.staff_members%ROWTYPE;
BEGIN
  v_cached := app.begin_command(p_request_id,'close_abandoned_count_batch',v_actor,
    jsonb_build_object('batch',p_batch_id,'reason',p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'CLOSURE_REASON_REQUIRED';
  END IF;
  SELECT * INTO b FROM app.count_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COUNT_BATCH_NOT_FOUND'; END IF;
  IF b.finished_at IS NULL THEN
    -- Serialize the availability decision with Auth deletion and reactivation.
    SELECT * INTO STRICT v_owner FROM app.staff_members WHERE id=b.owner_id FOR SHARE;
    IF v_owner.is_active AND v_owner.auth_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'COUNT_BATCH_OWNER_STILL_ACTIVE';
    END IF;
    UPDATE app.count_batches
      SET finished_at=clock_timestamp(),finished_by=v_actor,finish_reason=btrim(p_reason)
      WHERE id=p_batch_id;
  END IF;
  RETURN app.finish_command(p_request_id,jsonb_build_object('batch_id',p_batch_id,'finished',true));
END $$;

-- ---------- Anonymous checkout: server-only RPCs ----------
CREATE FUNCTION public.amp_prepare_checkout(
  p_request_id uuid,p_token text,p_items jsonb,p_contact_text text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cached jsonb; v_id uuid; r record; p app.products%ROWTYPE; v_quantity app.quantity;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_CHECKOUT_TOKEN'; END IF;
  v_cached := app.begin_command(p_request_id,'prepare_checkout',NULL,
    jsonb_build_object('token_digest',encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      'items',p_items,'contact',p_contact_text));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  PERFORM app.check_items(p_items);
  IF (SELECT count(*)<>count(DISTINCT item.value->>'product_id') FROM jsonb_array_elements(p_items) AS item(value))
    THEN RAISE EXCEPTION 'DUPLICATE_OR_MISSING_CART_PRODUCT'; END IF;
  PERFORM app.lock_products(ARRAY(SELECT (item.value->>'product_id')::uuid FROM jsonb_array_elements(p_items) AS item(value)));
  INSERT INTO app.checkouts(request_id,token_digest)
    VALUES(p_request_id,sha256(convert_to(p_token,'UTF8'))) RETURNING id INTO v_id;
  FOR r IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO STRICT p FROM app.products WHERE id=(r.value->>'product_id')::uuid;
    IF NOT p.is_active THEN RAISE EXCEPTION 'PRODUCT_NOT_FOR_SALE'; END IF;
    v_quantity := (r.value->>'quantity')::numeric;
    PERFORM app.validate_quantity(p.id,v_quantity,true);
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'POSITIVE_CART_QUANTITY_REQUIRED'; END IF;
    INSERT INTO app.checkout_lines(checkout_id,product_id,product_name_nb_snapshot,product_name_en_snapshot,quantity,unit_price_nok)
      VALUES(v_id,p.id,p.name_nb,p.name_en,v_quantity,p.sale_unit_price_nok);
  END LOOP;
  IF nullif(btrim(p_contact_text),'') IS NOT NULL THEN
    INSERT INTO app.checkout_contacts VALUES(v_id,btrim(p_contact_text));
  END IF;
  RETURN app.finish_command(p_request_id,jsonb_build_object('checkout_id',v_id));
END $$;

CREATE FUNCTION app.check_checkout_token(p_checkout_id uuid,p_token text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' OR NOT EXISTS (
    SELECT 1 FROM app.checkouts WHERE id=p_checkout_id AND token_digest=sha256(convert_to(p_token,'UTF8'))
  ) THEN RAISE EXCEPTION 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION public.amp_get_checkout(p_checkout_id uuid,p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM app.check_checkout_token(p_checkout_id,p_token);
  SELECT jsonb_build_object('checkout_id',c.id,'created_at',c.created_at,
    'status',CASE WHEN s.checkout_id IS NULL THEN 'unconfirmed' ELSE 'confirmed' END,
    'confirmed_at',e.recorded_at,'total_nok',t.total_nok::text,'payment_required',t.total_nok>0,
    'registration_method',CASE WHEN s.checkout_id IS NULL THEN NULL WHEN s.recovered_by IS NULL THEN 'buyer' ELSE 'staff_recovery' END,
    'contact_text',ct.contact_text,'items',(
      SELECT jsonb_agg(jsonb_build_object('product_id',l.product_id,'code',p.code,
        'name_nb',l.product_name_nb_snapshot,'name_en',l.product_name_en_snapshot,'unit',p.unit_code,'quantity',l.quantity::text,
        'unit_price_nok',l.unit_price_nok::text,'line_total_nok',round(l.quantity*l.unit_price_nok,2)::text)
        ORDER BY p.code)
      FROM app.checkout_lines l JOIN app.products p ON p.id=l.product_id WHERE l.checkout_id=c.id))
  INTO v_result
  FROM app.checkouts c JOIN app.checkout_totals t ON t.checkout_id=c.id
  LEFT JOIN app.sales s ON s.checkout_id=c.id LEFT JOIN app.inventory_events e ON e.id=s.event_id
  LEFT JOIN app.checkout_contacts ct ON ct.checkout_id=c.id WHERE c.id=p_checkout_id;
  RETURN v_result;
END $$;
-- Both buyer confirmation and staff recovery use this same natural identity.
-- The caller performs authorization; this helper has no API execution grant.
CREATE FUNCTION app.post_checkout(
  p_checkout_id uuid,p_recovered_by uuid DEFAULT NULL,p_recovery_reason text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event uuid;
BEGIN
  PERFORM app.require_read_committed();
  PERFORM 1 FROM app.checkouts WHERE id=p_checkout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHECKOUT_NOT_FOUND_OR_NOT_AUTHORISED' USING ERRCODE='42501'; END IF;
  SELECT event_id INTO v_event FROM app.sales WHERE checkout_id=p_checkout_id;
  IF v_event IS NOT NULL THEN RETURN v_event; END IF;
  PERFORM app.lock_products(ARRAY(SELECT product_id FROM app.checkout_lines WHERE checkout_id=p_checkout_id));
  INSERT INTO app.inventory_events(kind,actor_id) VALUES('sale',NULL) RETURNING id INTO v_event;
  INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
    SELECT v_event,product_id,-quantity FROM app.checkout_lines WHERE checkout_id=p_checkout_id ORDER BY product_id;
  INSERT INTO app.sales(checkout_id,event_id,recovered_by,recovery_reason)
    VALUES(p_checkout_id,v_event,p_recovered_by,p_recovery_reason);
  -- A saved checkout remains confirmable at its saved price, including zero.
  -- Registration is never evidence of verified payment.
  RETURN v_event;
END $$;

CREATE FUNCTION public.amp_confirm_checkout(p_checkout_id uuid,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.check_checkout_token(p_checkout_id,p_token);
  PERFORM app.post_checkout(p_checkout_id);
  RETURN public.amp_get_checkout(p_checkout_id,p_token);
END $$;

CREATE FUNCTION public.amp_recover_checkout(p_request_id uuid,p_checkout_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_cached jsonb; v_event uuid;
BEGIN
  v_cached := app.begin_command(p_request_id,'recover_checkout',v_actor,
    jsonb_build_object('checkout',p_checkout_id,'reason',p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'RECOVERY_REASON_REQUIRED';
  END IF;
  v_event := app.post_checkout(p_checkout_id,v_actor,btrim(p_reason));
  RETURN app.finish_command(p_request_id,jsonb_build_object(
    'checkout_id',p_checkout_id,'event_id',v_event,'status','confirmed'));
END $$;

CREATE FUNCTION public.amp_clear_checkout_contact(p_checkout_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_removed boolean;
BEGIN
  DELETE FROM app.checkout_contacts WHERE checkout_id=p_checkout_id;
  v_removed := FOUND;
  IF v_removed THEN
    INSERT INTO app.audit_log(table_name,row_key,action,actor_id,database_role)
      VALUES('checkout_contacts',jsonb_build_object('checkout_id',p_checkout_id),'CONTACT_CLEARED',
        v_actor,coalesce(nullif(current_setting('role',true),'none'),session_user));
  END IF;
  RETURN jsonb_build_object('checkout_id',p_checkout_id,'contact_removed',v_removed);
END $$;

-- Staff reporting uses original registered sales, never payment verification or
-- later stock corrections. One statement snapshot covers every returned total.
CREATE FUNCTION public.amp_admin_statistics(p_product_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_end date := (statement_timestamp() AT TIME ZONE 'Europe/Oslo')::date;
  v_result jsonb;
BEGIN
  PERFORM app.require_staff();
  IF p_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.products WHERE id=p_product_id) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;
  WITH sale_lines AS (
    SELECT s.checkout_id,l.product_id,l.quantity,round(l.quantity*l.unit_price_nok,2) AS total_nok,
      (e.recorded_at AT TIME ZONE 'Europe/Oslo')::date AS day
    FROM app.sales s JOIN app.inventory_events e ON e.id=s.event_id
    JOIN app.checkout_lines l ON l.checkout_id=s.checkout_id
    WHERE e.recorded_at >= (v_end-29)::timestamp AT TIME ZONE 'Europe/Oslo'
      AND e.recorded_at < (v_end+1)::timestamp AT TIME ZONE 'Europe/Oslo'
      AND (p_product_id IS NULL OR l.product_id=p_product_id)
  ), daily AS (
    SELECT day,count(DISTINCT checkout_id) AS sale_count,sum(total_nok) AS total_nok,sum(quantity) AS quantity
    FROM sale_lines GROUP BY day
  ), top_products AS (
    SELECT p.id AS product_id,p.code,p.name_nb,p.name_en,p.unit_code,count(*) AS sale_count,
      sum(l.quantity) AS quantity,sum(l.total_nok) AS total_nok
    FROM sale_lines l JOIN app.products p ON p.id=l.product_id
    WHERE p_product_id IS NULL
    GROUP BY p.id ORDER BY total_nok DESC,p.code LIMIT 10
  ), attention AS (
    -- Active products that are sold out (negative first), then those below their
    -- minimum, most depleted relative to it first. Units never compare directly.
    SELECT p.id AS product_id,p.code,p.name_nb,p.name_en,p.unit_code,i.quantity,p.minimum_stock,
      row_number() OVER (ORDER BY (i.quantity<0) DESC,(i.quantity<=0) DESC,
        CASE WHEN i.quantity>0 THEN i.quantity/p.minimum_stock END,p.code) AS position
    FROM app.products p JOIN app.inventory i ON i.product_id=p.id
    WHERE p_product_id IS NULL AND p.is_active AND (i.quantity<=0 OR i.quantity<p.minimum_stock)
  ), open_counts AS (
    SELECT id,title,started_at FROM app.count_batches
    WHERE p_product_id IS NULL AND finished_at IS NULL
  )
  SELECT jsonb_build_object(
    'product_id',p_product_id,'start_date',v_end-29,'end_date',v_end,
    'summary',(SELECT jsonb_build_object('sale_count',count(DISTINCT checkout_id)::text,
      'total_nok',coalesce(sum(total_nok),0.00)::text,
      'quantity',CASE WHEN p_product_id IS NOT NULL THEN coalesce(sum(quantity),0)::text END) FROM sale_lines),
    'days',(SELECT jsonb_agg(jsonb_build_object('date',v_end-29+n,
      'sale_count',coalesce(d.sale_count,0)::text,'total_nok',coalesce(d.total_nok,0.00)::text,
      'quantity',CASE WHEN p_product_id IS NOT NULL THEN coalesce(d.quantity,0)::text END) ORDER BY n)
      FROM generate_series(0,29) n LEFT JOIN daily d ON d.day=v_end-29+n),
    'products',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'product_id',product_id,'code',code,'name_nb',name_nb,'name_en',name_en,'unit_code',unit_code,
      'sale_count',sale_count::text,'quantity',quantity::text,'total_nok',total_nok::text)
      ORDER BY total_nok DESC,code),'[]'::jsonb) FROM top_products),
    'overview',CASE WHEN p_product_id IS NULL THEN jsonb_build_object(
      'attention_count',(SELECT count(*)::text FROM attention),
      'open_count_count',(SELECT count(*)::text FROM open_counts),
      'attention',(SELECT coalesce(jsonb_agg(jsonb_build_object(
        'product_id',product_id,'code',code,'name_nb',name_nb,'name_en',name_en,
        'unit_code',unit_code,'quantity',quantity::text,'minimum_stock',minimum_stock::text) ORDER BY position),'[]'::jsonb)
        FROM attention WHERE position<=8),
      'open_counts',(SELECT coalesce(jsonb_agg(to_jsonb(limited) ORDER BY started_at,id),'[]'::jsonb)
        FROM (SELECT * FROM open_counts ORDER BY started_at,id LIMIT 5) limited)) END)
  INTO v_result;
  RETURN v_result;
END $$;

-- Public catalogue deliberately contains NO purchase costs, contacts, tokens,
-- staff identities, checkout history or internal notes.
-- Search aliases and SI choices come from the same small client dictionaries as
-- display. Only public text is matched; aliases never select SQL or expose data.
CREATE FUNCTION app.catalog_fold(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT replace(replace(lower(normalize(p_text,NFKC) COLLATE "und-x-icu"),'ß','ss'),'ς','σ')
$$;

CREATE FUNCTION app.catalog_measurement(p_value numeric,p_unit text,p_locale text,p_units jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_choices jsonb; v_exponent integer; v_symbol text; v_number text; v_whole text; v_fraction text;
BEGIN
  v_choices := coalesce(p_units->p_unit,jsonb_build_array(jsonb_build_object('symbol',coalesce(p_unit,''),'exponent',0)));
  SELECT exponent,symbol INTO v_exponent,v_symbol FROM jsonb_to_recordset(v_choices) AS u(symbol text,exponent integer)
    ORDER BY CASE WHEN p_value=0 THEN exponent=0 ELSE abs(p_value)>=power(10::numeric,exponent) END DESC,
      CASE WHEN p_value=0 OR abs(p_value)>=power(10::numeric,exponent) THEN exponent ELSE -exponent END DESC LIMIT 1;
  v_number := trim_scale(p_value*power(10::numeric,-v_exponent))::text;
  v_whole := split_part(v_number,'.',1); v_fraction := split_part(v_number,'.',2);
  v_whole := regexp_replace(v_whole,'([0-9])(?=([0-9]{3})+(?![0-9]))',
    E'\\1'||CASE WHEN p_locale='nb' THEN U&'\202f' ELSE ',' END,'g');
  RETURN v_whole||CASE WHEN v_fraction='' THEN '' ELSE CASE WHEN p_locale='nb' THEN ',' ELSE '.' END||v_fraction END
    ||CASE WHEN v_symbol='' THEN '' ELSE ' '||v_symbol END;
END $$;

CREATE FUNCTION app.catalog_name_measurements(p_text text,p_locale text,p_units jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_pattern text := '(?<![[:alnum:]_./+,−–—-])([+-]?(?:[0-9](?:[0-9.,/ −–—  -]*[0-9])?|[.,][0-9]+))[[:space:]]*([[:alpha:]Ωµμ]+)(?![[:alnum:]_−–—-])';
  v_rest text := p_text; v_result text := ''; v_match text[]; v_start integer; v_end integer;
  v_unit text; v_exponent integer; v_number text; v_replacement text;
BEGIN
  LOOP
    v_match := regexp_match(v_rest COLLATE "und-x-icu",v_pattern);
    EXIT WHEN v_match IS NULL;
    v_start := regexp_instr(v_rest COLLATE "und-x-icu",v_pattern);
    v_end := regexp_instr(v_rest COLLATE "und-x-icu",v_pattern,1,1,1);
    v_replacement := substring(v_rest FROM v_start FOR v_end-v_start);
    SELECT unit.key,u.exponent INTO v_unit,v_exponent FROM jsonb_each(p_units) unit
      CROSS JOIN LATERAL jsonb_to_recordset(unit.value) AS u(symbol text,exponent integer)
      WHERE unit.key IN ('Ω','F','H','V','A','W','Hz') AND v_match[2] IN (
        u.symbol,replace(u.symbol,'µ','u'),replace(u.symbol,'µ','μ'),
        CASE WHEN unit.key='Ω' THEN replace(u.symbol,'Ω','ohm') END,
        CASE WHEN unit.key='Ω' THEN replace(u.symbol,'Ω','ohms') END,
        CASE WHEN unit.key='Ω' THEN replace(u.symbol,'Ω','Ohm') END,
        CASE WHEN unit.key='Ω' THEN replace(u.symbol,'Ω','Ohms') END) LIMIT 1;
    v_number := CASE WHEN p_locale='nb' THEN replace(v_match[1],',','.') ELSE v_match[1] END;
    IF v_unit IS NOT NULL AND v_number ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
      AND (v_result||substring(v_rest FROM 1 FOR v_start-1)) !~* '[0-9][[:space:]]+(to|til|and|og|or|eller)[[:space:]]*$' THEN
      v_replacement := app.catalog_measurement(v_number::numeric*power(10::numeric,v_exponent),v_unit,p_locale,p_units);
    END IF;
    v_result := v_result||substring(v_rest FROM 1 FOR v_start-1)||v_replacement;
    v_rest := substring(v_rest FROM v_end);
  END LOOP;
  RETURN v_result||v_rest;
END $$;

CREATE FUNCTION app.check_catalog_query(p_q text,p_categories text[],p_conditions jsonb,p_labels jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_code text; v_condition jsonb; v_definition app.attribute_definitions%ROWTYPE;
  v_key text; v_value jsonb; v_number text;
BEGIN
  IF p_q IS NULL OR char_length(p_q)>200 OR p_categories IS NULL OR cardinality(p_categories)>100
    OR EXISTS (SELECT 1 FROM unnest(p_categories) c WHERE c IS NULL OR length(c) NOT BETWEEN 1 AND 100)
    OR cardinality(p_categories)<>(SELECT count(DISTINCT c) FROM unnest(p_categories) c)
    OR jsonb_typeof(p_conditions) IS DISTINCT FROM 'object' OR length(p_conditions::text)>65536
    OR jsonb_typeof(p_labels) IS DISTINCT FROM 'object' OR length(p_labels::text)>65536
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_labels) k WHERE k NOT IN ('categories','attributes','units')) THEN
    RAISE EXCEPTION 'INVALID_CATALOG_QUERY';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_categories) c WHERE NOT EXISTS (
    SELECT 1 FROM app.categories category JOIN app.products p ON p.category_id=category.id AND p.is_active WHERE category.name=c)) THEN
    RAISE EXCEPTION 'UNKNOWN_CATALOG_CATEGORY';
  END IF;
  FOR v_code,v_condition IN SELECT * FROM jsonb_each(p_conditions) LOOP
    IF v_code !~ '^[a-z][a-z0-9_]{0,63}$' OR jsonb_typeof(v_condition)<>'object'
      OR v_condition='{}'::jsonb OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_condition) k WHERE k NOT IN ('eq','min','max'))
      OR (v_condition ? 'eq' AND (v_condition ? 'min' OR v_condition ? 'max')) THEN
      RAISE EXCEPTION 'INVALID_CATALOG_FILTER';
    END IF;
    SELECT d.* INTO v_definition FROM app.attribute_definitions d WHERE d.code=v_code AND EXISTS (
      SELECT 1 FROM app.product_attributes a JOIN app.products p ON p.id=a.product_id AND p.is_active
      LEFT JOIN app.categories c ON c.id=p.category_id
      WHERE a.attribute_id=d.id AND (cardinality(p_categories)=0 OR c.name=ANY(p_categories)));
    IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_CATALOG_ATTRIBUTE'; END IF;
    FOR v_key,v_value IN SELECT * FROM jsonb_each(v_condition) LOOP
      IF jsonb_typeof(v_value)<>'string' OR char_length(v_value#>>'{}')>2000
        OR (v_key IN ('min','max') AND v_definition.value_type<>'number') THEN RAISE EXCEPTION 'INVALID_CATALOG_FILTER'; END IF;
      v_number := btrim(v_value#>>'{}');
      IF v_definition.value_type='number' AND v_number !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' THEN
        RAISE EXCEPTION 'INVALID_CATALOG_FILTER';
      END IF;
      IF v_definition.value_type='boolean' AND v_value#>>'{}' NOT IN ('true','false') THEN RAISE EXCEPTION 'INVALID_CATALOG_FILTER'; END IF;
    END LOOP;
    IF v_definition.value_type='number' AND (v_condition->>'min')::numeric>(v_condition->>'max')::numeric THEN
      RAISE EXCEPTION 'INVALID_CATALOG_FILTER';
    END IF;
  END LOOP;
  FOR v_key,v_value IN SELECT * FROM jsonb_each(p_labels) LOOP
    IF jsonb_typeof(v_value)<>'object' THEN RAISE EXCEPTION 'INVALID_CATALOG_QUERY'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_each(coalesce(p_labels->'categories','{}')) c
    WHERE length(c.key)>100 OR jsonb_typeof(c.value)<>'string' OR char_length(c.value#>>'{}')>500) THEN
    RAISE EXCEPTION 'INVALID_CATALOG_QUERY';
  END IF;
  FOR v_code,v_value IN SELECT * FROM jsonb_each(coalesce(p_labels->'attributes','{}')) LOOP
    IF v_code !~ '^[a-z][a-z0-9_]{0,63}$' OR jsonb_typeof(v_value)<>'object'
      OR NOT v_value ?& ARRAY['labels','value_type','unit'] OR (SELECT count(*) FROM jsonb_object_keys(v_value))<>3
      OR jsonb_typeof(v_value->'labels')<>'string' OR char_length(v_value->>'labels')>500
      OR v_value->>'value_type' NOT IN ('number','text','boolean')
      OR jsonb_typeof(v_value->'unit') NOT IN ('string','null') OR char_length(v_value->>'unit')>100 THEN
      RAISE EXCEPTION 'INVALID_CATALOG_QUERY';
    END IF;
  END LOOP;
  FOR v_code,v_value IN SELECT * FROM jsonb_each(coalesce(p_labels->'units','{}')) LOOP
    IF length(v_code)>100 OR jsonb_typeof(v_value)<>'array' THEN RAISE EXCEPTION 'INVALID_CATALOG_QUERY'; END IF;
    IF jsonb_array_length(v_value) NOT BETWEEN 1 AND 16 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_value) u WHERE u->'exponent'='0'::jsonb) THEN
      RAISE EXCEPTION 'INVALID_CATALOG_QUERY';
    END IF;
    FOR v_condition IN SELECT value FROM jsonb_array_elements(v_value) LOOP
      IF jsonb_typeof(v_condition)<>'object' OR NOT v_condition ?& ARRAY['symbol','exponent']
        OR (SELECT count(*) FROM jsonb_object_keys(v_condition))<>2
        OR jsonb_typeof(v_condition->'symbol')<>'string' OR char_length(v_condition->>'symbol')>100
        OR jsonb_typeof(v_condition->'exponent')<>'number' OR (v_condition->>'exponent') !~ '^-?[0-9]{1,2}$'
        OR (v_condition->>'exponent')::integer NOT BETWEEN -12 AND 9 THEN RAISE EXCEPTION 'INVALID_CATALOG_QUERY'; END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION app.catalog_matches(p_product app.products,p_category text,p_q text,p_conditions jsonb,p_labels jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_search text; a record; v_alias jsonb; v_condition jsonb;
BEGIN
  IF p_q<>'' THEN
    v_search := concat_ws(' ',p_product.code,replace(p_product.code,'-',''),p_product.name_nb,p_product.name_en,p_product.description,p_category,
      app.catalog_name_measurements(p_product.name_nb,'nb',coalesce(p_labels->'units','{}')),
      app.catalog_name_measurements(p_product.name_en,'en',coalesce(p_labels->'units','{}')),
      p_labels->'categories'->>lower(btrim(p_category)));
  END IF;
  FOR a IN SELECT d.code,d.label,d.value_type,d.canonical_unit,p.number_value,p.text_value,p.boolean_value
    FROM app.product_attributes p JOIN app.attribute_definitions d ON d.id=p.attribute_id WHERE p.product_id=p_product.id LOOP
    v_condition := p_conditions->a.code;
    IF v_condition IS NOT NULL THEN
      IF a.value_type='number' THEN
        IF (v_condition ? 'eq' AND a.number_value<>(v_condition->>'eq')::numeric)
          OR (v_condition ? 'min' AND a.number_value<(v_condition->>'min')::numeric)
          OR (v_condition ? 'max' AND a.number_value>(v_condition->>'max')::numeric) THEN RETURN false; END IF;
      ELSIF coalesce(a.text_value,a.boolean_value::text) IS DISTINCT FROM v_condition->>'eq' THEN RETURN false;
      END IF;
    END IF;
    IF p_q<>'' THEN
      v_alias := p_labels->'attributes'->a.code;
      v_search := concat_ws(' ',v_search,a.label,
        CASE WHEN v_alias->>'value_type'=a.value_type AND (v_alias->>'unit') IS NOT DISTINCT FROM a.canonical_unit THEN v_alias->>'labels' END,
        coalesce(a.number_value::text,a.text_value,CASE WHEN a.boolean_value THEN 'true yes ja' ELSE 'false no nei' END),a.canonical_unit,
        CASE WHEN a.value_type='number' THEN app.catalog_measurement(a.number_value,a.canonical_unit,'nb',coalesce(p_labels->'units','{}')) END,
        CASE WHEN a.value_type='number' THEN app.catalog_measurement(a.number_value,a.canonical_unit,'en',coalesce(p_labels->'units','{}')) END);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_conditions) AS keys(code) WHERE NOT EXISTS (
    SELECT 1 FROM app.product_attributes pa JOIN app.attribute_definitions d ON d.id=pa.attribute_id
    WHERE pa.product_id=p_product.id AND d.code=keys.code)) THEN RETURN false; END IF;
  IF p_q='' THEN RETURN true; END IF;
  v_search := app.catalog_fold(v_search);
  RETURN NOT EXISTS (SELECT 1 FROM regexp_split_to_table(app.catalog_fold(p_q),'[[:space:]]+') term WHERE term<>'' AND position(term IN v_search)=0);
END $$;

-- Immutable unique code is the keyset cursor. Continue until an empty page,
-- even after a short page: an API row cap may be smaller than p_limit.
CREATE FUNCTION public.amp_catalog(p_code text DEFAULT NULL,p_after_code text DEFAULT NULL,
  p_limit integer DEFAULT 200,p_q text DEFAULT '',p_categories text[] DEFAULT '{}',
  p_conditions jsonb DEFAULT '{}',p_bin_id uuid DEFAULT NULL,p_labels jsonb DEFAULT '{}',
  p_cabinet_ids uuid[] DEFAULT '{}',p_bin_ids uuid[] DEFAULT '{}')
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
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'INVALID_CATALOG_PAGE_SIZE';
  END IF;
  PERFORM app.check_catalog_query(p_q,p_categories,p_conditions,p_labels);
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
  IF p_code IS NULL AND p_after_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.products p WHERE p.is_active AND p.code=p_after_code) THEN
    RAISE EXCEPTION 'CATALOG_CURSOR_MISSING';
  END IF;
  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT p.* FROM app.products p LEFT JOIN app.categories c ON c.id=p.category_id
    WHERE p.is_active AND (p_code IS NULL OR p.code=p_code)
      AND (p_code IS NOT NULL OR p_after_code IS NULL OR p.code>p_after_code)
      AND (p_bin_id IS NULL OR p.bin_id=p_bin_id)
      AND (cardinality(p_cabinet_ids)=0 AND cardinality(p_bin_ids)=0
        OR p.bin_id=ANY(p_bin_ids) OR EXISTS (
          SELECT 1 FROM app.bins b WHERE b.id=p.bin_id AND b.cabinet_id=ANY(p_cabinet_ids)))
      AND (cardinality(p_categories)=0 OR c.name=ANY(p_categories))
      AND (p_q='' AND p_conditions='{}'::jsonb OR app.catalog_matches(p,c.name,p_q,p_conditions,p_labels))
    ORDER BY p.code LIMIT p_limit
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
  FROM selected p JOIN app.units u ON u.code=p.unit_code
  LEFT JOIN app.categories c ON c.id=p.category_id
  LEFT JOIN LATERAL (SELECT coalesce(sum(m.quantity_delta),0) AS quantity
    FROM app.inventory_movements m WHERE m.product_id=p.id) i ON true
  LEFT JOIN LATERAL (SELECT max(e.recorded_at) AS last_counted_at FROM app.stock_counts sc
    JOIN app.inventory_events e ON e.id=sc.event_id WHERE sc.product_id=p.id) counted ON true
  LEFT JOIN app.bins b ON b.id=p.bin_id
  LEFT JOIN app.cabinets cab ON cab.id=b.cabinet_id
  ORDER BY p.code;
END $$;

CREATE FUNCTION public.amp_catalog_facets(p_categories text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM app.check_catalog_query('',p_categories,'{}','{}');
  WITH attribute_values AS MATERIALIZED (
    SELECT p.code AS product_code,d.code,d.label,d.value_type,d.canonical_unit,
      a.number_value,a.text_value,a.boolean_value
    FROM app.products p JOIN app.product_attributes a ON a.product_id=p.id
    JOIN app.attribute_definitions d ON d.id=a.attribute_id LEFT JOIN app.categories c ON c.id=p.category_id
    WHERE p.is_active AND (cardinality(p_categories)=0 OR c.name=ANY(p_categories))
  ), definitions AS (SELECT DISTINCT ON (code) * FROM attribute_values ORDER BY code,product_code)
  SELECT jsonb_build_object('categories',(SELECT coalesce(jsonb_agg(name ORDER BY first_code),'[]') FROM (
      SELECT c.name,min(p.code) AS first_code FROM app.products p JOIN app.categories c ON c.id=p.category_id WHERE p.is_active GROUP BY c.name
    ) categories),
    'attributes',coalesce(jsonb_agg(jsonb_build_object('code',d.code,
      'definition',jsonb_build_object('label',d.label,'unit',d.canonical_unit,'value_type',d.value_type,
        'value',coalesce(to_jsonb(d.number_value::text),to_jsonb(d.text_value),to_jsonb(d.boolean_value))),
      'values',CASE d.value_type
        WHEN 'number' THEN (SELECT jsonb_agg(trim_scale(n.number_value)::text ORDER BY n.number_value) FROM (SELECT DISTINCT v.number_value FROM attribute_values v WHERE v.code=d.code) n)
        WHEN 'text' THEN (SELECT jsonb_agg(t.text_value ORDER BY t.first_code) FROM (SELECT v.text_value,min(v.product_code) first_code FROM attribute_values v WHERE v.code=d.code GROUP BY v.text_value) t)
        ELSE '[]'::jsonb END) ORDER BY d.product_code,d.code),'[]'::jsonb)) INTO v_result FROM definitions d;
  RETURN v_result;
END $$;

-- A single JSON value is a complete physical map; API row limits cannot truncate
-- it. Empty cabinets and bins remain visible, independently of active products.
-- Free cells are derived from these complete grids and occupied bin rectangles.
CREATE FUNCTION public.amp_shelf_map() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'cabinets',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',c.id,'code',c.code,'outer_row',c.outer_row,
      'outer_col',c.outer_col,'inner_rows',c.inner_rows,'inner_cols',c.inner_cols,'label',c.label)
      ORDER BY c.outer_row,c.outer_col,c.code)
      FROM app.cabinets c WHERE NOT c.is_archived),'[]'::jsonb),
    'bins',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',b.id,'code',b.code,'cabinet_id',b.cabinet_id,'inner_row',b.inner_row,
      'inner_col',b.inner_col,'row_span',b.row_span,'col_span',b.col_span,
      'label',b.label,'has_products',EXISTS(SELECT 1 FROM app.products p WHERE p.bin_id=b.id)) ORDER BY b.code)
      FROM app.bins b JOIN app.cabinets c ON c.id=b.cabinet_id
      WHERE NOT b.is_archived AND NOT c.is_archived),'[]'::jsonb))
$$;

-- Dedicated published-only directory; no Auth link, draft or edit metadata.
-- The tuple cursor includes ID so equal display orders cannot skip contacts.
CREATE FUNCTION public.amp_help_directory(p_after_order integer DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid,display_name text,email text,phone text,contact_url text,display_order integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'INVALID_HELP_PAGE_SIZE';
  END IF;
  IF (p_after_order IS NULL) <> (p_after_id IS NULL) OR p_after_order < 0 THEN
    RAISE EXCEPTION 'INVALID_HELP_CURSOR';
  END IF;
  RETURN QUERY SELECT c.id,c.display_name,c.email,c.phone,c.contact_url,c.display_order
    FROM app.help_contacts c WHERE c.is_published
      AND (p_after_order IS NULL OR (c.display_order,c.id) > (p_after_order,p_after_id))
    ORDER BY c.display_order,c.id LIMIT p_limit;
END $$;

-- ---------- Explicit permissions, RLS, and exposed staff views ----------
-- No API role receives direct DML on ledger, orders, checkouts or commands.
-- Secret/service credentials can execute only the guest gateway functions.
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA app TO authenticated;
GRANT EXECUTE ON FUNCTION app.is_staff() TO authenticated;
GRANT USAGE ON TYPE app.quantity,app.stock_quantity,app.unit_price,app.nok_amount TO authenticated;

DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t.tablename);
    EXECUTE format('CREATE POLICY staff_read ON app.%I FOR SELECT TO authenticated USING ((SELECT app.is_staff()))',t.tablename);
  END LOOP;
END $$;

-- These normal master-data edits are one SQL statement each, with RLS and
-- automatic before/after audit. Operational writes use the RPCs above.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['categories','cabinets','bins','products','attribute_definitions','product_attributes','help_contacts'] LOOP
    EXECUTE format('CREATE POLICY staff_insert ON app.%I FOR INSERT TO authenticated WITH CHECK ((SELECT app.is_staff()))',t);
    EXECUTE format('CREATE POLICY staff_update ON app.%I FOR UPDATE TO authenticated USING ((SELECT app.is_staff())) WITH CHECK ((SELECT app.is_staff()))',t);
  END LOOP;
END $$;
CREATE POLICY staff_delete_attribute ON app.product_attributes FOR DELETE TO authenticated USING ((SELECT app.is_staff()));
GRANT SELECT ON app.units,app.staff_members,app.help_contacts,app.categories,app.cabinets,app.bins,app.products,
  app.attribute_definitions,app.product_attributes,app.purchase_orders,app.purchase_order_lines,
  app.purchase_order_cancellations,app.checkout_lines,app.checkout_contacts,app.sales,
  app.count_batches,app.inventory_events,app.inventory_movements,app.movement_corrections,app.receipt_allocations,
  app.stock_counts,app.audit_log,app.inventory,app.purchase_line_progress,app.latest_purchase,app.checkout_totals,app.cabinet_free_cells TO authenticated;
GRANT SELECT (id,request_id,created_at) ON app.checkouts TO authenticated;
GRANT INSERT (id,display_name,email,phone,contact_url,display_order,is_published)
  ON app.help_contacts TO authenticated;
GRANT UPDATE (display_name,email,phone,contact_url,display_order,is_published,edit_revision)
  ON app.help_contacts TO authenticated;
GRANT INSERT,UPDATE ON app.categories,app.cabinets,app.bins TO authenticated;
GRANT INSERT ON app.attribute_definitions TO authenticated;
GRANT UPDATE (label) ON app.attribute_definitions TO authenticated;
GRANT INSERT,DELETE ON app.product_attributes TO authenticated;
GRANT UPDATE (number_value,text_value,boolean_value) ON app.product_attributes TO authenticated;
GRANT INSERT (id,code,name_nb,name_en,description,category_id,bin_id,location_note,unit_code,stock_step,sale_step,
  sale_unit_price_nok,minimum_stock,datasheet_url,purchase_url,is_active) ON app.products TO authenticated;
GRANT UPDATE (name_nb,name_en,description,category_id,bin_id,location_note,sale_step,sale_unit_price_nok,minimum_stock,datasheet_url,purchase_url,is_active)
  ON app.products TO authenticated;

-- Purchase metadata corrections are audited. Quantities, product links and
-- original order identity cannot be overwritten by application users.
CREATE POLICY staff_update ON app.purchase_orders FOR UPDATE TO authenticated
  USING ((SELECT app.is_staff())) WITH CHECK ((SELECT app.is_staff()));
CREATE POLICY staff_update ON app.purchase_order_lines FOR UPDATE TO authenticated
  USING ((SELECT app.is_staff())) WITH CHECK ((SELECT app.is_staff()));
GRANT UPDATE (supplier_name,supplier_reference,placed_at,additional_cost_nok,note)
  ON app.purchase_orders TO authenticated;
GRANT UPDATE (unit_cost_nok,purchase_url,supplier_sku) ON app.purchase_order_lines TO authenticated;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['units','staff_members','help_contacts','categories','cabinets','bins','products',
    'attribute_definitions','product_attributes','purchase_orders','purchase_order_lines',
    'purchase_order_cancellations','checkout_lines','checkout_contacts','sales','count_batches',
    'inventory_events','inventory_movements','movement_corrections','receipt_allocations','stock_counts','audit_log',
    'inventory','purchase_line_progress','latest_purchase','checkout_totals','cabinet_free_cells'] LOOP
    EXECUTE format('CREATE VIEW public.%I WITH (security_invoker=true) AS SELECT * FROM app.%I','amp_'||t,t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role','amp_'||t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated','amp_'||t);
  END LOOP;
END $$;
CREATE VIEW public.amp_checkouts WITH (security_invoker=true) AS SELECT id,request_id,created_at FROM app.checkouts;
REVOKE ALL ON public.amp_checkouts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.amp_checkouts TO authenticated;

GRANT INSERT (id,display_name,email,phone,contact_url,display_order,is_published)
  ON public.amp_help_contacts TO authenticated;
GRANT UPDATE (display_name,email,phone,contact_url,display_order,is_published,edit_revision)
  ON public.amp_help_contacts TO authenticated;
GRANT INSERT,UPDATE ON public.amp_categories,public.amp_cabinets,public.amp_bins TO authenticated;
GRANT INSERT ON public.amp_attribute_definitions TO authenticated;
GRANT UPDATE (label) ON public.amp_attribute_definitions TO authenticated;
GRANT INSERT,DELETE ON public.amp_product_attributes TO authenticated;
GRANT UPDATE (number_value,text_value,boolean_value) ON public.amp_product_attributes TO authenticated;
GRANT INSERT (id,code,name_nb,name_en,description,category_id,bin_id,location_note,unit_code,stock_step,sale_step,
  sale_unit_price_nok,minimum_stock,datasheet_url,purchase_url,is_active) ON public.amp_products TO authenticated;
GRANT UPDATE (name_nb,name_en,description,category_id,bin_id,location_note,sale_step,sale_unit_price_nok,minimum_stock,datasheet_url,purchase_url,is_active)
  ON public.amp_products TO authenticated;
GRANT UPDATE (supplier_name,supplier_reference,placed_at,additional_cost_nok,note)
  ON public.amp_purchase_orders TO authenticated;
GRANT UPDATE (unit_cost_nok,purchase_url,supplier_sku) ON public.amp_purchase_order_lines TO authenticated;

-- Only touch this migration's public functions, not unrelated Supabase objects.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature,p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'amp\_%' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname IN ('amp_prepare_checkout','amp_get_checkout','amp_confirm_checkout') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    ELSIF f.proname IN ('amp_catalog','amp_catalog_facets','amp_shelf_map','amp_help_directory') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon,authenticated,service_role',f.signature);
    ELSIF f.proname IN ('amp_record_order','amp_record_receipt','amp_cancel_order_quantities',
      'amp_reverse_cancellation','amp_adjust_stock','amp_withdraw_stock','amp_start_count_batch',
      'amp_record_count','amp_record_single_count','amp_finish_count_batch','amp_clear_checkout_contact',
      'amp_save_shelf_layout','amp_swap_bins','amp_swap_cabinets',
      'amp_close_abandoned_count_batch','amp_correct_movement_and_count','amp_recover_checkout',
      'amp_admin_statistics') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
    ELSE
      RAISE EXCEPTION 'UNREVIEWED_PUBLIC_FUNCTION: %',f.signature;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst,'reload schema';
