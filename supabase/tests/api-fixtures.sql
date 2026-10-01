-- Used only by scripts/test-api.sh in its own disposable database.
\set ON_ERROR_STOP on
\ir fixtures.sql
INSERT INTO auth.users(id) VALUES ('71000000-0000-4000-8000-000000000003');
UPDATE app.staff_members SET is_active=false WHERE id='72000000-0000-4000-8000-000000000002';
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
ALTER SEQUENCE app.inventory_movements_id_seq RESTART WITH 9007199254740993;
ALTER SEQUENCE app.audit_log_id_seq RESTART WITH 9007199254740993;
UPDATE app.products SET sale_unit_price_nok=999999999998.999999 WHERE code='TEST-R';
UPDATE app.product_attributes SET number_value=999999999998.999999
WHERE product_id='73000000-0000-4000-8000-000000000001';
INSERT INTO app.products(code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
SELECT 'PAGE-'||lpad(i::text,4,'0'),'Paginering-fikstur','Pagination fixture',
  '75000000-0000-4000-8000-000000000001','pcs',1,1,0,true
FROM generate_series(1,1103) i;
DO $$ BEGIN
  FOR i IN 1..1103 LOOP
    PERFORM public.amp_record_receipt(gen_random_uuid(),
      '[{"product_id":"73000000-0000-4000-8000-000000000001","quantity":"1"}]'::jsonb,
      NULL,'HTTP pagination fixture');
  END LOOP;
END $$;
-- Both topology arrays exceed the API's deliberately small 37-row limit.
INSERT INTO app.cabinets(code,outer_row,outer_col,inner_rows,inner_cols)
SELECT 'EMPTY-CAB-'||i,2,i,2,2 FROM generate_series(1,40) i;
INSERT INTO app.bins(code,cabinet_id,inner_row,inner_col)
SELECT 'EMPTY-BIN-'||i,'74000000-0000-4000-8000-000000000001',
  1+(i-1)/12,1+(i-1)%12 FROM generate_series(2,48) i;
INSERT INTO app.products(code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok)
SELECT 'INACTIVE','Inaktiv fikstur','Inactive fixture',id,'pcs',1,1,0 FROM app.bins WHERE code='EMPTY-BIN-2';
UPDATE app.bins SET is_archived=true WHERE code='EMPTY-BIN-48';
UPDATE app.cabinets SET is_archived=true WHERE code='EMPTY-CAB-40';
-- Equal sort orders span several HTTP pages; drafts never enter the public set.
INSERT INTO app.help_contacts(display_name,email,display_order,is_published)
SELECT 'Directory fixture '||i,'volunteer'||i||'@example.invalid',i/50,true
FROM generate_series(1,83) i;
-- Inserts always go last; force the ties the cursor must survive.
UPDATE app.help_contacts SET display_order=substring(display_name FROM '[0-9]+$')::integer/50
WHERE display_name LIKE 'Directory fixture %';
INSERT INTO app.help_contacts(display_name) VALUES ('Private directory draft');
