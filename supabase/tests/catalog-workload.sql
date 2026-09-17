-- Query work, not wall-clock timing: unrelated ledger growth must not increase
-- a small catalog page or direct product lookup's inventory tuple reads.
\set ON_ERROR_STOP on
BEGIN;
\ir fixtures.sql
-- Bulk synthetic fixture only; restore normal trigger behavior before reads.
SET LOCAL session_replication_role=replica;
INSERT INTO app.products(id,code,name_nb,name_en,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active)
  SELECT md5('catalog-workload-'||n)::uuid,'WORK-'||lpad(n::text,6,'0'),'Workload','Workload',
    '75000000-0000-4000-8000-000000000001','pcs',1,1,2,true FROM generate_series(1,5000) n;
INSERT INTO app.inventory_events(id,kind,actor_id,note)
  VALUES ('11111111-1111-4111-8111-111111111111','adjustment','72000000-0000-4000-8000-000000000001','Disposable workload');
INSERT INTO app.inventory_movements(event_id,product_id,quantity_delta)
  SELECT '11111111-1111-4111-8111-111111111111',md5('catalog-workload-'||p)::uuid,1
  FROM generate_series(1,5000) p CROSS JOIN generate_series(1,50) n;
SET LOCAL session_replication_role=origin;
ANALYZE app.products;
ANALYZE app.inventory_movements;
DO $$ DECLARE before_reads bigint; after_reads bigint; rows_read bigint; value text;
BEGIN
  SELECT seq_tup_read+idx_tup_fetch INTO before_reads FROM pg_stat_xact_user_tables WHERE relid='app.inventory_movements'::regclass;
  SELECT count(*) INTO rows_read FROM public.amp_catalog(NULL,NULL,20);
  SELECT seq_tup_read+idx_tup_fetch INTO after_reads FROM pg_stat_xact_user_tables WHERE relid='app.inventory_movements'::regclass;
  IF rows_read<>20 OR after_reads-before_reads>2000 THEN RAISE EXCEPTION 'CATALOG_PAGE_SCANNED_UNRELATED_LEDGER: %',after_reads-before_reads; END IF;
  before_reads:=after_reads;
  SELECT quantity INTO value FROM public.amp_catalog('WORK-004999');
  SELECT seq_tup_read+idx_tup_fetch INTO after_reads FROM pg_stat_xact_user_tables WHERE relid='app.inventory_movements'::regclass;
  IF value<>'50' OR after_reads-before_reads>100 THEN RAISE EXCEPTION 'CATALOG_LOOKUP_SCANNED_UNRELATED_LEDGER: %',after_reads-before_reads; END IF;
  before_reads:=after_reads;
  SELECT count(*) INTO rows_read FROM public.amp_catalog(p_q=>'not-present-anywhere');
  SELECT seq_tup_read+idx_tup_fetch INTO after_reads FROM pg_stat_xact_user_tables WHERE relid='app.inventory_movements'::regclass;
  IF rows_read<>0 OR after_reads<>before_reads THEN RAISE EXCEPTION 'CATALOG_EMPTY_SEARCH_READ_LEDGER'; END IF;
  RAISE NOTICE 'PASS: 5002 products / 250000 movements; catalog pages and direct lookup read only selected products, empty search reads no ledger';
END $$;
ROLLBACK;
