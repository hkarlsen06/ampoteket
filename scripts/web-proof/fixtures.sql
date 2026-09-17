-- Real Auth users are created by the local Auth admin API before this fixture.
INSERT INTO app.staff_members(auth_user_id,display_name) VALUES (:'staff_id', 'Proof volunteer');
-- Keep proof inventory separate from the physical layout installed by migrations.
INSERT INTO app.cabinets(id,code,outer_row,outer_col,inner_rows,inner_cols)
SELECT '74000000-0000-4000-8000-000000000001','PROOF-CAB',coalesce(max(outer_row),0)+1,1,2,2
FROM app.cabinets;
INSERT INTO app.bins(id,code,cabinet_id,inner_row,inner_col)
VALUES ('75000000-0000-4000-8000-000000000001','PROOF-BIN','74000000-0000-4000-8000-000000000001',1,1);
INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active) VALUES
('73000000-0000-4000-8000-000000000001','CAP-00001','Bevis-kondensator','Proof capacitor','75000000-0000-4000-8000-000000000001','pcs',1,1,999999999998.999999,true),
('73000000-0000-4000-8000-000000000002','LED-00001','Bevis-LED','Proof LED','75000000-0000-4000-8000-000000000001','pcs',1,1,0,true),
('73000000-0000-4000-8000-000000000003','RES-00001','Bevis-motstand','Proof resistor','75000000-0000-4000-8000-000000000001','pcs',1,1,0.005,true);
INSERT INTO app.attribute_definitions(id,code,label,value_type,canonical_unit)
VALUES ('76000000-0000-4000-8000-000000000001','capacitance','Capacitance','number','F');
INSERT INTO app.product_attributes(product_id,attribute_id,number_value)
VALUES ('73000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',0.000000000005);
