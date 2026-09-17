-- Synthetic fixtures for disposable databases only.
-- Isolate deliberate empty-grid/placement scenarios from the initial workshop map.
UPDATE app.bins SET is_archived=true WHERE id::text LIKE 'a0000002-%' AND NOT is_archived;
UPDATE app.cabinets SET is_archived=true WHERE id::text LIKE 'a0000001-%' AND NOT is_archived;
INSERT INTO auth.users(id) VALUES
  ('71000000-0000-4000-8000-000000000001'),('71000000-0000-4000-8000-000000000002');
INSERT INTO app.staff_members(id,auth_user_id,display_name) VALUES
  ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','Test staff A'),
  ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','Test staff B');
INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols)
  VALUES('74000000-0000-4000-8000-000000000001','TEST-CAB-1',1,1,4,12);
INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col,row_span,col_span)
  VALUES('75000000-0000-4000-8000-000000000001','TEST-BIN-1','74000000-0000-4000-8000-000000000001',1,1,1,1);
INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active) VALUES
 ('73000000-0000-4000-8000-000000000001','TEST-R','Testmotstand','Test resistor','75000000-0000-4000-8000-000000000001','pcs',1,1,2,true),
 ('73000000-0000-4000-8000-000000000002','TEST-C','Testkabel','Test cable','75000000-0000-4000-8000-000000000001','m',0.001,0.1,12,true);
INSERT INTO app.attribute_definitions(id,code,label,value_type,canonical_unit)
 VALUES('76000000-0000-4000-8000-000000000001','test_resistance','Resistance','number','ohm');
INSERT INTO app.product_attributes(product_id,attribute_id,number_value)
 VALUES('73000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',1000);
