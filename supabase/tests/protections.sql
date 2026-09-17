-- Run after every migration: new application tables are unprotected until reviewed.
-- Covers exact table/view surfaces, policy predicates, enabled trigger bindings,
-- and table/column grants. Never certify a restore merely because names exist.
-- A future migration that adds a table (or loosens a grant) must consciously
-- extend this allowlist, exactly like adding an RPC to permissions.sql.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE expected_tables(
  name text PRIMARY KEY,
  -- authenticated privilege per kind: 'none', 'column' (column grants only) or 'table'
  sel text NOT NULL, ins text NOT NULL, upd text NOT NULL, del text NOT NULL,
  immutable boolean NOT NULL,  -- immutable_rows + immutable_truncate triggers
  audited boolean NOT NULL,    -- audit_metadata trigger
  kept boolean NOT NULL        -- keep_records BEFORE DELETE trigger
);
INSERT INTO expected_tables VALUES
 ('units',                        'table','none',  'none',  'none', false,true, true ),
 ('staff_members',                'table','none',  'none',  'none', false,true, true ),
 ('help_contacts',                'table','column','column','none', false,true, true ),
 ('categories',                   'table','table', 'table', 'none', false,true, true ),
 ('cabinets',                     'table','table', 'table', 'none', false,true, true ),
 ('bins',                         'table','table', 'table', 'none', false,true, true ),
 ('products',                     'table','column','column','none', false,true, true ),
 ('attribute_definitions',        'table','table', 'column','none', false,true, true ),
 ('product_attributes',           'table','table', 'column','table',false,true, false),
 ('command_requests',             'none', 'none',  'none',  'none', false,false,false),
 ('purchase_orders',              'table','none',  'column','none', false,true, true ),
 ('purchase_order_lines',         'table','none',  'column','none', false,true, true ),
 ('purchase_order_cancellations', 'table','none',  'none',  'none', true, false,false),
 ('checkouts',                    'column','none', 'none',  'none', true, false,false),
 ('checkout_lines',               'table','none',  'none',  'none', true, false,false),
 ('checkout_contacts',            'table','none',  'none',  'none', false,false,false),
 ('count_batches',                'table','none',  'none',  'none', false,true, true ),
 ('inventory_events',             'table','none',  'none',  'none', true, false,false),
 ('inventory_movements',          'table','none',  'none',  'none', true, false,false),
 ('movement_corrections',         'table','none',  'none',  'none', true, false,false),
 ('receipt_allocations',          'table','none',  'none',  'none', true, false,false),
 ('sales',                        'table','none',  'none',  'none', true, false,false),
 ('stock_counts',                 'table','none',  'none',  'none', true, false,false),
 ('audit_log',                    'table','none',  'none',  'none', true, false,false);

-- Column grants are intentional boundaries, not just "some column access".
CREATE TEMP TABLE expected_columns(
  relation_name text, privilege text, columns name[],
  PRIMARY KEY (relation_name, privilege)
);
INSERT INTO expected_columns VALUES
 ('help_contacts','INSERT',ARRAY['id','display_name','email','phone','contact_url','display_order','is_published']::name[]),
 ('help_contacts','UPDATE',ARRAY['display_name','email','phone','contact_url','display_order','is_published','edit_revision']::name[]),
 ('products','INSERT',ARRAY['id','code','name_nb','name_en','description','category_id','bin_id','location_note','unit_code','stock_step','sale_step','sale_unit_price_nok','minimum_stock','datasheet_url','purchase_url','is_active']::name[]),
 ('products','UPDATE',ARRAY['name_nb','name_en','description','category_id','bin_id','location_note','sale_step','sale_unit_price_nok','minimum_stock','datasheet_url','purchase_url','is_active']::name[]),
 ('attribute_definitions','UPDATE',ARRAY['label']::name[]),
 ('product_attributes','UPDATE',ARRAY['number_value','text_value','boolean_value']::name[]),
 ('purchase_orders','UPDATE',ARRAY['supplier_name','supplier_reference','placed_at','additional_cost_nok','note']::name[]),
 ('purchase_order_lines','UPDATE',ARRAY['unit_cost_nok','purchase_url','supplier_sku']::name[]),
 ('checkouts','SELECT',ARRAY['id','request_id','created_at']::name[]);

CREATE TEMP TABLE expected_views(
  schema_name name, name name, sel text, ins text, upd text, del text,
  PRIMARY KEY (schema_name,name)
);
INSERT INTO expected_views
  SELECT 'public', 'amp_' || name, 'table',ins,upd,del FROM expected_tables
  WHERE name <> 'command_requests';
INSERT INTO expected_views
  SELECT s, CASE WHEN s='public' THEN 'amp_' ELSE '' END || v,
         'table','none','none','none'
  FROM unnest(ARRAY['app','public']) s
  CROSS JOIN unnest(ARRAY['inventory','purchase_line_progress','latest_purchase',
                         'checkout_totals','cabinet_free_cells']) v;
INSERT INTO expected_views VALUES
  ('public','amp_archived_bin_locations','table','none','none','none');

CREATE TEMP TABLE expected_policies(
  table_name name, name name, command "char", using_staff boolean, check_staff boolean,
  PRIMARY KEY(table_name,name)
);
INSERT INTO expected_policies
  SELECT name,'staff_read','r',true,false FROM expected_tables;
INSERT INTO expected_policies
  SELECT name,'staff_insert','a',false,true FROM expected_tables WHERE ins <> 'none';
INSERT INTO expected_policies
  SELECT name,'staff_update','w',true,true FROM expected_tables WHERE upd <> 'none';
INSERT INTO expected_policies VALUES ('product_attributes','staff_delete_attribute','d',true,false);

CREATE TEMP TABLE expected_triggers(
  table_name name, name name, function_signature regprocedure, trigger_type smallint,
  is_deferrable boolean DEFAULT false, PRIMARY KEY(table_name,name)
);
-- pg_trigger.tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8,
-- UPDATE=16, TRUNCATE=32. AFTER and statement-level are zero bits.
INSERT INTO expected_triggers
 SELECT name,'immutable_rows','app.reject_mutation()'::regprocedure,27,false
 FROM expected_tables WHERE immutable;
INSERT INTO expected_triggers
 SELECT name,'immutable_truncate','app.reject_mutation()'::regprocedure,34,false
 FROM expected_tables WHERE immutable;
INSERT INTO expected_triggers
 SELECT name,'audit_metadata','app.audit_metadata()'::regprocedure,29,false
 FROM expected_tables WHERE audited;
INSERT INTO expected_triggers
 SELECT name,'keep_records','app.reject_mutation()'::regprocedure,11,false
 FROM expected_tables WHERE kept;
INSERT INTO expected_triggers VALUES
 ('help_contacts','guard_help_contact','app.guard_help_contact()',23,false),
 ('products','guard_product','app.guard_product()',23,false),
 ('attribute_definitions','guard_attribute_definition','app.guard_attribute_definition()',19,false),
 ('product_attributes','guard_attribute_value','app.guard_attribute_value()',23,false),
 ('bins','guard_bin_archive','app.guard_bin_archive()',23,false),
 ('bins','bin_no_overlap','app.check_bin_placement()',21,true),
 ('cabinets','guard_cabinet_shrink','app.guard_cabinet_shrink()',19,false),
 ('inventory_movements','guard_movement','app.guard_movement()',7,false),
 ('movement_corrections','guard_correction','app.guard_correction()',7,false),
 ('receipt_allocations','guard_receipt_allocation','app.guard_receipt_allocation()',7,false),
 ('purchase_order_lines','guard_purchase_line','app.guard_purchase_line()',23,false);

DO $$
DECLARE t record; s record; v_review record; v_role name; p text; v_kind text; v_expected text;
  v_columns name[]; v_expected_columns name[]; v_predicate text;
  privs text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    privs := array_append(privs,'MAINTAIN');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')
             AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication))
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated') AND rolbypassrls) THEN
    RAISE EXCEPTION 'UNSAFE_API_ROLE_ATTRIBUTES';
  END IF;
  FOR t IN SELECT a.tablename FROM pg_tables a LEFT JOIN expected_tables e ON e.name=a.tablename
           WHERE a.schemaname='app' AND e.name IS NULL LOOP
    RAISE EXCEPTION 'UNREVIEWED_TABLE: app.%',t.tablename;
  END LOOP;
  FOR t IN SELECT e.name FROM expected_tables e LEFT JOIN pg_tables a
           ON a.schemaname='app' AND a.tablename=e.name WHERE a.tablename IS NULL LOOP
    RAISE EXCEPTION 'MISSING_TABLE: app.%',t.name;
  END LOOP;

  -- PostgreSQL's canonical expression, whitespace aside. Compare the expression,
  -- command, permissiveness, role AND presence of each policy, in both directions.
  v_predicate := '(SELECTapp.is_staff()ASis_staff)';
  FOR t IN SELECT p.*, c.relname FROM pg_policy p
    JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'
  LOOP
    SELECT * INTO v_review FROM expected_policies x WHERE x.table_name=t.relname AND x.name=t.polname;
    IF NOT FOUND THEN RAISE EXCEPTION 'UNREVIEWED_POLICY: app.%.%',t.relname,t.polname; END IF;
    IF NOT t.polpermissive OR t.polcmd <> v_review.command
       OR t.polroles <> ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]
       OR regexp_replace(pg_get_expr(t.polqual,t.polrelid),'\s','','g')
          IS DISTINCT FROM (CASE WHEN v_review.using_staff THEN v_predicate END)
       OR regexp_replace(pg_get_expr(t.polwithcheck,t.polrelid),'\s','','g')
          IS DISTINCT FROM (CASE WHEN v_review.check_staff THEN v_predicate END) THEN
      RAISE EXCEPTION 'POLICY_DEFINITION_MISMATCH: app.%.%',t.relname,t.polname;
    END IF;
  END LOOP;
  FOR v_review IN SELECT x.* FROM expected_policies x WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p WHERE p.polrelid=('app.'||x.table_name)::regclass AND p.polname=x.name
  ) LOOP
    RAISE EXCEPTION 'MISSING_POLICY: app.%.%',v_review.table_name,v_review.name;
  END LOOP;

  -- Include internal FK triggers in enabled-state checks. Restoring with session
  -- replication role "replica" also bypasses ordinary triggers and must be rejected.
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'UNSAFE_SESSION_REPLICATION_ROLE';
  END IF;
  FOR t IN SELECT tr.*, c.relname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'
  LOOP
    IF t.tgenabled <> 'O' THEN
      RAISE EXCEPTION 'TRIGGER_NOT_ENABLED: app.%.%',t.relname,t.tgname;
    END IF;
    IF t.tgisinternal THEN CONTINUE; END IF;
    SELECT * INTO v_review FROM expected_triggers x WHERE x.table_name=t.relname AND x.name=t.tgname;
    IF NOT FOUND THEN RAISE EXCEPTION 'UNREVIEWED_TRIGGER: app.%.%',t.relname,t.tgname; END IF;
    IF t.tgfoid <> v_review.function_signature OR t.tgtype <> v_review.trigger_type
       OR t.tgdeferrable <> v_review.is_deferrable OR t.tginitdeferred
       OR t.tgnargs <> 0 OR t.tgqual IS NOT NULL OR cardinality(t.tgattr::smallint[]) <> 0
       OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL THEN
      RAISE EXCEPTION 'TRIGGER_DEFINITION_MISMATCH: app.%.%',t.relname,t.tgname;
    END IF;
  END LOOP;
  FOR v_review IN SELECT x.* FROM expected_triggers x WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger trigg WHERE trigg.tgrelid=('app.'||x.table_name)::regclass AND trigg.tgname=x.name
  ) LOOP
    RAISE EXCEPTION 'MISSING_TRIGGER: app.%.%',v_review.table_name,v_review.name;
  END LOOP;

  FOR s IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('v','m') AND (n.nspname='app' OR
      (n.nspname='public' AND c.relname LIKE 'amp\_%' ESCAPE '\'))
  LOOP
    IF NOT EXISTS (SELECT 1 FROM expected_views v WHERE v.schema_name=s.nspname AND v.name=s.relname) THEN
      RAISE EXCEPTION 'UNREVIEWED_VIEW: %.%',s.nspname,s.relname;
    END IF;
  END LOOP;
  FOR v_review IN SELECT v.*,c.oid,c.relkind,c.reloptions FROM expected_views v
    LEFT JOIN pg_namespace n ON n.nspname=v.schema_name
    LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=v.name
  LOOP
    IF v_review.oid IS NULL OR v_review.relkind <> 'v' THEN RAISE EXCEPTION 'MISSING_VIEW: %.%',v_review.schema_name,v_review.name; END IF;
    IF NOT coalesce(v_review.reloptions @> ARRAY['security_invoker=true'],false) THEN
      RAISE EXCEPTION 'VIEW_NOT_SECURITY_INVOKER: %.%',v_review.schema_name,v_review.name;
    END IF;
  END LOOP;

  -- Check both base relations and exposed views. Updatable views have their own
  -- grants: a base-table allowlist cannot certify the complete API boundary.
  FOR t IN
    SELECT 'app'::name AS schema_name,e.name,e.sel,e.ins,e.upd,e.del,
           c.oid AS reloid,c.relrowsecurity,c.relacl,c.relowner,true AS is_table
    FROM expected_tables e JOIN pg_namespace n ON n.nspname='app'
    JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.name
    UNION ALL
    SELECT e.schema_name,e.name,e.sel,e.ins,e.upd,e.del,
           c.oid,c.relrowsecurity,c.relacl,c.relowner,false
    FROM expected_views e JOIN pg_namespace n ON n.nspname=e.schema_name
    JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.name
  LOOP
    IF t.is_table AND NOT t.relrowsecurity THEN
      RAISE EXCEPTION 'RLS_DISABLED: %.%',t.schema_name,t.name;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) WHERE grantee=0)
       OR EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                  WHERE a.attrelid=t.reloid AND x.grantee=0) THEN
      RAISE EXCEPTION 'PUBLIC_RELATION_PRIVILEGE: %.%',t.schema_name,t.name;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role']::name[] LOOP
      FOREACH p IN ARRAY privs LOOP
        v_expected := CASE WHEN v_role <> 'authenticated' THEN 'none'
          WHEN p='SELECT' THEN t.sel WHEN p='INSERT' THEN t.ins
          WHEN p='UPDATE' THEN t.upd WHEN p='DELETE' THEN t.del ELSE 'none' END;
        v_kind := CASE WHEN has_table_privilege(v_role,t.reloid,p) THEN 'table'
          WHEN p IN ('SELECT','INSERT','UPDATE','REFERENCES') AND has_any_column_privilege(v_role,t.reloid,p) THEN 'column'
          ELSE 'none' END;
        IF v_kind <> v_expected THEN
          RAISE EXCEPTION 'RELATION_PRIVILEGE_MISMATCH: % % on %.% is % (expected %)',
            v_role,p,t.schema_name,t.name,v_kind,v_expected;
        END IF;
        IF v_expected='column' THEN
          SELECT array_agg(a.attname ORDER BY a.attname) INTO v_columns FROM pg_attribute a
            WHERE a.attrelid=t.reloid AND a.attnum>0 AND NOT a.attisdropped
              AND has_column_privilege(v_role,t.reloid,a.attnum,p);
          SELECT ARRAY(SELECT unnest(x.columns) ORDER BY 1) INTO v_expected_columns
            FROM expected_columns x WHERE x.relation_name=
              CASE WHEN t.schema_name='public' THEN substr(t.name,5) ELSE t.name END AND x.privilege=p;
          IF v_columns IS DISTINCT FROM v_expected_columns THEN
            RAISE EXCEPTION 'COLUMN_PRIVILEGE_MISMATCH: % % on %.% is % (expected %)',
              v_role,p,t.schema_name,t.name,v_columns,v_expected_columns;
          END IF;
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM aclexplode(t.relacl) a JOIN pg_roles r ON r.oid=a.grantee
                 WHERE r.rolname=v_role AND a.is_grantable)
         OR EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                    JOIN pg_roles r ON r.oid=x.grantee
                    WHERE a.attrelid=t.reloid AND r.rolname=v_role AND x.is_grantable) THEN
        RAISE EXCEPTION 'UNEXPECTED_GRANT_OPTION: % on %.%',v_role,t.schema_name,t.name;
      END IF;
    END LOOP;
  END LOOP;

  FOR s IN SELECT c.oid AS reloid,c.relname,c.relacl,c.relowner FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='S' LOOP
    IF EXISTS (SELECT 1 FROM aclexplode(coalesce(s.relacl,acldefault('S',s.relowner))) WHERE grantee=0) THEN
      RAISE EXCEPTION 'PUBLIC_SEQUENCE_PRIVILEGE: app.%',s.relname;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role']::name[] LOOP
      IF has_sequence_privilege(v_role,s.reloid,'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'UNEXPECTED_SEQUENCE_PRIVILEGE: % on app.%',v_role,s.relname;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS: exact application policies, triggers, invoker views and privileges';
END $$;
ROLLBACK;
