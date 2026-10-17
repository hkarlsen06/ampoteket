/**
 * Ampoteket data model on Convex.
 *
 * Field names deliberately match the original PostgreSQL columns
 * (docs/datamodell.md), so imported rows, audit images and client parsers keep
 * one vocabulary. Every row keeps its UUID in `id` (looked up by the `uuid`
 * index); that UUID, not Convex's `_id`, is the identity clients and URLs use.
 *
 * Value conventions:
 * - Quantities, prices and specification numbers are exact decimal strings
 *   (convex/lib/decimal.ts). Never store them as `number`.
 * - Timestamps are UTC ISO strings with microseconds ("2026-10-17T10:00:00.000000Z"),
 *   so string order is time order.
 * - Optional columns hold explicit `null`, like the SQL rows they replace.
 * - Sequence numbers (movement and audit IDs) are safe integers from `counters`.
 *
 * Nothing that history refers to is deleted (datamodell.md §1). Ledger tables are
 * append-only: only convex/lib/inventory.ts and convex/lib/audit.ts insert into them.
 */
import { defineSchema, defineTable } from 'convex/server';
import { authTables } from '@convex-dev/auth/server';
import { v, type Validator } from 'convex/values';

const nullable = <T extends Validator<unknown, 'required', string>>(validator: T) => v.union(validator, v.null());
const text = v.string();
const uuid = v.string();
const decimal = v.string();
const timestamp = v.string();
const newsImageRef = v.object({ id: v.string(), alt: v.string() });
const newsLink = v.object({ label: v.string(), url: v.string() });

export default defineSchema({
	...authTables,
	// Convex Auth's users table, plus the stable UUID the app has always used for
	// an Auth identity (imported from Supabase `auth.users.id`, new for new users).
	users: defineTable({
		name: v.optional(v.string()),
		image: v.optional(v.string()),
		email: v.optional(v.string()),
		emailVerificationTime: v.optional(v.number()),
		phone: v.optional(v.string()),
		phoneVerificationTime: v.optional(v.number()),
		isAnonymous: v.optional(v.boolean()),
		auth_user_id: v.optional(v.string())
	}).index('email', ['email']).index('phone', ['phone']).index('auth_user_id', ['auth_user_id']),

	units: defineTable({ code: text, name: text, symbol: text, is_discrete: v.boolean() }).index('code', ['code']),

	staff_members: defineTable({
		id: uuid, auth_user_id: nullable(uuid), display_name: text, is_active: v.boolean(), created_at: timestamp
	}).index('uuid', ['id']).index('auth_user_id', ['auth_user_id']),

	help_contacts: defineTable({
		id: uuid, display_name: text, email: nullable(text), phone: nullable(text), contact_url: nullable(text),
		display_order: v.number(), is_published: v.boolean(), edit_revision: v.number(),
		created_at: timestamp, updated_at: timestamp, responsibility: nullable(text), discord: nullable(text)
	}).index('uuid', ['id']).index('display_order', ['display_order', 'id']),

	// Newsroom (docs/page-news.md). Articles and events are separate rows; an event
	// belongs to at most one article (`article_id`). Slugs are chosen once and never
	// change. Image and link lists are ordered; the first image is the cover. An article
	// body places an image with a paragraph of its own, `[image:<id>]`. `author` is the
	// byline (optional, so rows written before it existed stay valid).
	news_articles: defineTable({
		id: uuid, slug: text, title: text, author: v.optional(nullable(text)), summary: nullable(text), body: text, images: v.array(newsImageRef), links: v.array(newsLink),
		people: v.array(uuid), is_published: v.boolean(), published_at: nullable(timestamp), edit_revision: v.number(),
		created_at: timestamp, updated_at: timestamp
	}).index('uuid', ['id']).index('slug', ['slug']).index('published', ['is_published', 'published_at', 'id']),

	events: defineTable({
		id: uuid, slug: text, title: text, description: text, location: nullable(text), starts_at: timestamp, ends_at: nullable(timestamp),
		article_id: nullable(uuid), images: v.array(newsImageRef), links: v.array(newsLink), people: v.array(uuid), is_published: v.boolean(),
		edit_revision: v.number(), created_at: timestamp, updated_at: timestamp
	}).index('uuid', ['id']).index('slug', ['slug']).index('article_id', ['article_id']).index('published_start', ['is_published', 'starts_at', 'id']),

	// Uploaded images never change. The bytes sit in their own table, so lists and
	// pages read only the size, and snapshot exports cover them like any other row.
	news_images: defineTable({
		id: uuid, content_type: v.union(v.literal('image/webp'), v.literal('image/jpeg'), v.literal('image/png')),
		width: v.number(), height: v.number(), created_by: uuid, created_at: timestamp
	}).index('uuid', ['id']),
	news_image_data: defineTable({ image_id: uuid, data: v.bytes() }).index('image_id', ['image_id']),
	// Which article or event lists each image, rewritten by every save (convex/news.ts),
	// so the public image endpoint can check publication without scanning rows.
	news_image_uses: defineTable({ image_id: uuid, owner_id: uuid }).index('image_id', ['image_id']).index('owner_id', ['owner_id']),

	categories: defineTable({ id: uuid, name: text }).index('uuid', ['id']).index('name', ['name']),

	cabinets: defineTable({
		id: uuid, code: text, outer_row: nullable(v.number()), outer_col: nullable(v.number()),
		inner_rows: v.number(), inner_cols: v.number(), label: nullable(text), is_archived: v.boolean()
	}).index('uuid', ['id']).index('code', ['code']).index('position', ['outer_row', 'outer_col']),

	bins: defineTable({
		id: uuid, code: text, cabinet_id: nullable(uuid), inner_row: nullable(v.number()), inner_col: nullable(v.number()),
		row_span: v.number(), col_span: v.number(), label: nullable(text), is_archived: v.boolean()
	}).index('uuid', ['id']).index('code', ['code']).index('cabinet_id', ['cabinet_id']),

	products: defineTable({
		id: uuid, code: text, name_nb: text, name_en: text, description: nullable(text),
		category_id: nullable(uuid), bin_id: nullable(uuid), location_note: nullable(text), unit_code: text,
		stock_step: decimal, sale_step: decimal, sale_unit_price_nok: nullable(decimal), minimum_stock: decimal,
		datasheet_url: nullable(text), purchase_url: nullable(text), is_active: v.boolean(),
		metadata_revision: v.number(), created_at: timestamp, updated_at: timestamp
	}).index('uuid', ['id']).index('code', ['code']).index('bin_id', ['bin_id']).index('category_id', ['category_id'])
		.index('created_at', ['created_at']).index('is_active_code', ['is_active', 'code']),

	attribute_definitions: defineTable({
		id: uuid, code: text, label: text, value_type: v.union(v.literal('number'), v.literal('text'), v.literal('boolean')),
		canonical_unit: nullable(text)
	}).index('uuid', ['id']).index('code', ['code']),

	product_attributes: defineTable({
		product_id: uuid, attribute_id: uuid, number_value: nullable(decimal), text_value: nullable(text),
		boolean_value: nullable(v.boolean()), number_max: nullable(decimal)
	}).index('product_attribute', ['product_id', 'attribute_id']).index('attribute_id', ['attribute_id']),

	// Retry record for one command, completed in the command's own transaction.
	command_requests: defineTable({
		id: uuid, command_name: text, actor_id: nullable(uuid), request_digest: text,
		result: v.union(v.any(), v.null()), created_at: timestamp
	}).index('uuid', ['id']),

	purchase_orders: defineTable({
		id: uuid, request_id: uuid, supplier_name: text, supplier_reference: nullable(text), placed_at: timestamp,
		additional_cost_nok: decimal, note: nullable(text), created_by: uuid, recorded_at: timestamp
	}).index('uuid', ['id']).index('request_id', ['request_id']),

	purchase_order_lines: defineTable({
		id: uuid, order_id: uuid, line_number: v.number(), product_id: uuid, ordered_quantity: decimal,
		unit_cost_nok: decimal, purchase_url: nullable(text), supplier_sku: nullable(text)
	}).index('uuid', ['id']).index('order_line', ['order_id', 'line_number']).index('product_id', ['product_id']),

	purchase_order_cancellations: defineTable({
		id: uuid, request_id: uuid, order_line_id: uuid, quantity: decimal, reverses_id: nullable(uuid),
		reason: text, created_by: uuid, recorded_at: timestamp
	}).index('uuid', ['id']).index('order_line_id', ['order_line_id']).index('reverses_id', ['reverses_id']),

	checkouts: defineTable({ id: uuid, request_id: uuid, token_digest: text, created_at: timestamp })
		.index('uuid', ['id']).index('request_id', ['request_id']),

	checkout_lines: defineTable({
		checkout_id: uuid, product_id: uuid, product_name_nb_snapshot: text, product_name_en_snapshot: text,
		quantity: decimal, unit_price_nok: decimal
	}).index('checkout_product', ['checkout_id', 'product_id']).index('product_id', ['product_id']),

	checkout_contacts: defineTable({ checkout_id: uuid, contact_text: text }).index('checkout_id', ['checkout_id']),

	count_batches: defineTable({
		id: uuid, request_id: uuid, owner_id: uuid, title: text, started_at: timestamp,
		finished_at: nullable(timestamp), finished_by: nullable(uuid), finish_reason: nullable(text), product_id: nullable(uuid)
	}).index('uuid', ['id']).index('product_id', ['product_id']).index('finished_at', ['finished_at', 'started_at']),

	inventory_events: defineTable({
		id: uuid, request_id: nullable(uuid),
		kind: v.union(v.literal('receipt'), v.literal('sale'), v.literal('count'), v.literal('adjustment'), v.literal('withdrawal')),
		actor_id: nullable(uuid), purchase_order_id: nullable(uuid), note: nullable(text), occurred_at: timestamp, recorded_at: timestamp
	}).index('uuid', ['id']).index('kind_order', ['kind', 'purchase_order_id']).index('recorded_at', ['recorded_at']),

	// The only source of balances. `id` is the global movement sequence and the stock revision.
	inventory_movements: defineTable({ id: v.number(), event_id: uuid, product_id: uuid, quantity_delta: decimal })
		.index('seq', ['id']).index('product', ['product_id', 'id']).index('event_id', ['event_id']),

	movement_corrections: defineTable({ movement_id: v.number(), corrects_movement_id: v.number() })
		.index('movement_id', ['movement_id']).index('corrects_movement_id', ['corrects_movement_id']),

	receipt_allocations: defineTable({ movement_id: v.number(), order_line_id: uuid })
		.index('movement_id', ['movement_id']).index('order_line_id', ['order_line_id']),

	sales: defineTable({ checkout_id: uuid, event_id: uuid, recovered_by: nullable(uuid), recovery_reason: nullable(text) })
		.index('checkout_id', ['checkout_id']).index('event_id', ['event_id']),

	stock_counts: defineTable({
		event_id: uuid, batch_id: uuid, product_id: uuid, expected_quantity: decimal, counted_quantity: decimal,
		expected_revision: v.number()
	}).index('event_id', ['event_id']).index('batch_id', ['batch_id']).index('product_id', ['product_id']),

	audit_log: defineTable({
		id: v.number(), table_name: text, row_key: v.any(), action: v.union(v.literal('INSERT'), v.literal('UPDATE'), v.literal('DELETE'), v.literal('CONTACT_CLEARED')),
		before_data: v.union(v.any(), v.null()), after_data: v.union(v.any(), v.null()), actor_id: nullable(uuid),
		database_role: text, recorded_at: timestamp,
		// row_key.id when the row has one, so a row's history is one index range.
		row_id: nullable(text)
	}).index('seq', ['id']).index('table_action', ['table_name', 'action', 'id']).index('table_row', ['table_name', 'row_id', 'id']),

	// Rebuildable projection of the ledger (datamodell.md §2 allows one): written
	// only by convex/lib/inventory.ts in the same transaction as each movement.
	stock_levels: defineTable({ product_id: uuid, quantity: decimal, revision: v.number(), last_counted_at: nullable(timestamp) })
		.index('product_id', ['product_id']),

	counters: defineTable({ name: text, value: v.number() }).index('name', ['name']),

	// Single-use invitation and password-reset links; only the SHA-256 is stored.
	password_tokens: defineTable({
		user_id: v.id('users'), token_digest: text, purpose: v.union(v.literal('invite'), v.literal('reset')),
		expires_at: v.number(), used_at: nullable(v.number())
	}).index('token_digest', ['token_digest']).index('user_id', ['user_id']),

	// Fixed-window limits for invitation and reset email.
	rate_limits: defineTable({ key: text, window_start: v.number(), count: v.number() }).index('key', ['key'])
});
