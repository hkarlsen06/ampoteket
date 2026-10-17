-- One consistent, read-only snapshot of everything the Convex import needs
-- (docs/runbook-cutover.md). Run only through scripts/convex-cutover/export.sh,
-- which wraps it in BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY.
--
-- Output: one JSON object. Numeric columns stay JSON numbers with their exact
-- text (the importer parses losslessly); timestamps are ISO 8601; bytea is
-- \x-hex text. `users` holds Auth identities with their bcrypt hashes and
-- `inventory` the derived stock the import is checked against.
SELECT json_build_object(
  'exported_at', clock_timestamp(),
  'migrations', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations),
  'tables', json_build_object(
    'units', (SELECT coalesce(json_agg(t ORDER BY code), '[]') FROM app.units t),
    'staff_members', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.staff_members t),
    'help_contacts', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.help_contacts t),
    'categories', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.categories t),
    'cabinets', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.cabinets t),
    'bins', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.bins t),
    'products', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.products t),
    'attribute_definitions', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.attribute_definitions t),
    'product_attributes', (SELECT coalesce(json_agg(t ORDER BY product_id, attribute_id), '[]') FROM app.product_attributes t),
    'command_requests', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.command_requests t),
    'purchase_orders', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.purchase_orders t),
    'purchase_order_lines', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.purchase_order_lines t),
    'purchase_order_cancellations', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.purchase_order_cancellations t),
    'checkouts', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.checkouts t),
    'checkout_lines', (SELECT coalesce(json_agg(t ORDER BY checkout_id, product_id), '[]') FROM app.checkout_lines t),
    'checkout_contacts', (SELECT coalesce(json_agg(t ORDER BY checkout_id), '[]') FROM app.checkout_contacts t),
    'count_batches', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.count_batches t),
    'inventory_events', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.inventory_events t),
    'inventory_movements', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.inventory_movements t),
    'movement_corrections', (SELECT coalesce(json_agg(t ORDER BY movement_id), '[]') FROM app.movement_corrections t),
    'receipt_allocations', (SELECT coalesce(json_agg(t ORDER BY movement_id), '[]') FROM app.receipt_allocations t),
    'sales', (SELECT coalesce(json_agg(t ORDER BY checkout_id), '[]') FROM app.sales t),
    'stock_counts', (SELECT coalesce(json_agg(t ORDER BY event_id), '[]') FROM app.stock_counts t),
    'audit_log', (SELECT coalesce(json_agg(t ORDER BY id), '[]') FROM app.audit_log t)
  ),
  'users', (SELECT coalesce(json_agg(json_build_object(
      'id', u.id, 'email', u.email, 'encrypted_password', nullif(u.encrypted_password, ''),
      'email_confirmed_at', u.email_confirmed_at) ORDER BY u.id), '[]')
    FROM auth.users u WHERE u.email IS NOT NULL AND u.deleted_at IS NULL),
  'inventory', (SELECT coalesce(json_agg(json_build_object('code', p.code, 'quantity', i.quantity, 'revision', i.revision,
      'last_counted_at', i.last_counted_at) ORDER BY p.code), '[]')
    FROM app.inventory i JOIN app.products p ON p.id = i.product_id)
);
