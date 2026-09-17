-- Read-only invariant diagnostic for the v1 schema.
--
-- Run after restore, schema changes and suspected data problems
-- (docs/operating-procedures.md), during deploys/backup verification
-- (docs/runbook-deploy.md, docs/runbook-backup-restore.md), and by
-- scripts/test-database.sh / supabase/tests/invariant-detector.py, which
-- injects rollback-only corruptions and requires each named finding below.
--
-- It checks stored facts only: it must pass on any legitimately operated
-- database, including archived empty storage, historical staff whose Auth
-- account was deleted, buyer-confirmed and staff-recovered sales, corrections
-- and closed count batches. It never assumes an active-state rule that the
-- schema does not enforce. Findings are named; preserve the full message
-- before correcting anything.
--
-- The first and last lines below are stripped verbatim by
-- supabase/tests/invariant-detector.py to embed the body in its own
-- transaction; keep them exactly as written and keep the body free of
-- transaction control.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

DO $$
DECLARE
  v_count bigint;
  v_example text;
  r record;
BEGIN
  -- Placement: retiring storage must first empty it and release coordinates
  -- (docs/datamodell.md `cabinets`/`bins`; enforced by triggers that a broken
  -- restore or a superuser bypass can have sidestepped). Coordinate-release
  -- checks run before occupancy checks so a bin archived in place reports the
  -- retained placement, not only its remaining products.
  SELECT count(*), min(code) INTO v_count, v_example FROM app.bins
    WHERE is_archived AND (cabinet_id IS NOT NULL OR inner_row IS NOT NULL OR inner_col IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'archived_bin_has_placement: % archived bin(s) still hold coordinates, e.g. bin %', v_count, v_example;
  END IF;

  SELECT count(*), min(code) INTO v_count, v_example FROM app.cabinets
    WHERE is_archived AND (outer_row IS NOT NULL OR outer_col IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'archived_cabinet_has_placement: % archived cabinet(s) still hold coordinates, e.g. cabinet %', v_count, v_example;
  END IF;

  SELECT count(*), min(code) INTO v_count, v_example FROM app.bins
    WHERE NOT is_archived AND (cabinet_id IS NULL OR inner_row IS NULL OR inner_col IS NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'live_bin_without_placement: % live bin(s) lack a complete placement, e.g. bin %', v_count, v_example;
  END IF;

  SELECT count(*), min(p.code) INTO v_count, v_example
    FROM app.products p JOIN app.bins b ON b.id = p.bin_id WHERE b.is_archived;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'product_in_archived_bin: % product(s) still reference an archived bin, e.g. product %', v_count, v_example;
  END IF;

  SELECT count(*), min(b.code) INTO v_count, v_example
    FROM app.bins b JOIN app.cabinets c ON c.id = b.cabinet_id
    WHERE NOT b.is_archived AND c.is_archived;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'live_bin_in_archived_cabinet: % live bin(s) sit in an archived cabinet, e.g. bin %', v_count, v_example;
  END IF;

  -- Sales attribution: buyer confirmations carry neither recovery field;
  -- staff recoveries carry both, with a non-blank reason (docs/datamodell.md
  -- `sales`). Attribution references the internal staff row, so a deleted
  -- Auth account never invalidates history.
  SELECT count(*), min(checkout_id::text) INTO v_count, v_example FROM app.sales
    WHERE (recovered_by IS NULL) <> (recovery_reason IS NULL)
       OR (recovery_reason IS NOT NULL AND length(btrim(recovery_reason)) = 0);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'invalid_sale_attribution: % sale(s) with inconsistent recovery attribution, e.g. checkout %', v_count, v_example;
  END IF;

  -- Every staff recovery is a command; a restore that loses the command loses
  -- the idempotency and audit anchor for that recovery.
  SELECT count(*), min(s.checkout_id::text) INTO v_count, v_example FROM app.sales s
    WHERE s.recovered_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM app.command_requests c
      WHERE c.command_name = 'recover_checkout'
        AND c.result ->> 'checkout_id' = s.checkout_id::text);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'missing_recovery_command: % recovered sale(s) without their recover_checkout command, e.g. checkout %', v_count, v_example;
  END IF;

  -- A committed correction/recount command must still point at its recorded
  -- adjustment event and count observation.
  SELECT count(*), min(c.id::text) INTO v_count, v_example FROM app.command_requests c
    WHERE c.command_name = 'correct_movement_and_count' AND c.result IS NOT NULL
      AND (NOT EXISTS (SELECT 1 FROM app.inventory_events e WHERE e.id::text = c.result ->> 'correction_event_id')
        OR NOT EXISTS (SELECT 1 FROM app.stock_counts sc WHERE sc.event_id::text = c.result ->> 'count_event_id'));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'invalid_correction_recount_result: % correction command(s) reference a missing event or count observation, e.g. request %', v_count, v_example;
  END IF;

  -- Sales must equal their immutable checkout snapshot: one movement of
  -- -quantity per line, nothing more.
  SELECT count(*), min(s.checkout_id::text) INTO v_count, v_example FROM app.sales s
    WHERE EXISTS (
        SELECT 1 FROM app.checkout_lines l WHERE l.checkout_id = s.checkout_id
          AND NOT EXISTS (SELECT 1 FROM app.inventory_movements m
            WHERE m.event_id = s.event_id AND m.product_id = l.product_id AND m.quantity_delta = -l.quantity))
       OR EXISTS (
        SELECT 1 FROM app.inventory_movements m WHERE m.event_id = s.event_id
          AND NOT EXISTS (SELECT 1 FROM app.checkout_lines l
            WHERE l.checkout_id = s.checkout_id AND l.product_id = m.product_id AND m.quantity_delta = -l.quantity));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'sale_does_not_match_snapshot: % sale(s) whose movements differ from the checkout lines, e.g. checkout %', v_count, v_example;
  END IF;

  -- Referential integrity that replica-mode loads bypass: re-verify every
  -- foreign key declared on an app table (MATCH SIMPLE: rows with any NULL
  -- key column are not references).
  FOR r IN
    SELECT con.oid, con.conrelid::regclass AS tab, con.confrelid::regclass AS ftab, con.conname,
      (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
      (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
         FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS fcols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'f' AND nsp.nspname = 'app'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s t WHERE %s AND NOT EXISTS (SELECT 1 FROM %s f WHERE (%s) = (%s))',
      r.tab,
      (SELECT string_agg('t.' || c || ' IS NOT NULL', ' AND ') FROM unnest(r.cols) AS c),
      r.ftab,
      (SELECT string_agg('f.' || c, ',') FROM unnest(r.fcols) AS c),
      (SELECT string_agg('t.' || c, ',') FROM unnest(r.cols) AS c))
      INTO v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'V1_BROKEN_FOREIGN_KEY: % row(s) in % violate % against %', v_count, r.tab, r.conname, r.ftab;
    END IF;
  END LOOP;

  -- Last, so a disabled trigger can never hide a semantic finding above: the
  -- protective triggers themselves must be armed for ordinary sessions.
  SELECT count(*), min(rel.relname || '.' || tg.tgname) INTO v_count, v_example
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'app' AND NOT tg.tgisinternal AND tg.tgenabled <> 'O';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'disabled_or_replica_only_trigger: % trigger(s) not enabled for ordinary sessions, e.g. %', v_count, v_example;
  END IF;

  RAISE NOTICE 'PASS: v1 invariants hold';
END $$;

ROLLBACK;
