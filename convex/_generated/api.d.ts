/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as catalog from "../catalog.js";
import type * as checkout from "../checkout.js";
import type * as help from "../help.js";
import type * as http from "../http.js";
import type * as lib_archivedBins from "../lib/archivedBins.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_commands from "../lib/commands.js";
import type * as lib_decimal from "../lib/decimal.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_emailTemplates from "../lib/emailTemplates.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_ids from "../lib/ids.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_sequence from "../lib/sequence.js";
import type * as lib_staff from "../lib/staff.js";
import type * as lib_time from "../lib/time.js";
import type * as members from "../members.js";
import type * as migration from "../migration.js";
import type * as orders from "../orders.js";
import type * as passwords from "../passwords.js";
import type * as products from "../products.js";
import type * as seed from "../seed.js";
import type * as session from "../session.js";
import type * as shelf from "../shelf.js";
import type * as statistics from "../statistics.js";
import type * as stock from "../stock.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auditLog: typeof auditLog;
  auth: typeof auth;
  catalog: typeof catalog;
  checkout: typeof checkout;
  help: typeof help;
  http: typeof http;
  "lib/archivedBins": typeof lib_archivedBins;
  "lib/audit": typeof lib_audit;
  "lib/commands": typeof lib_commands;
  "lib/decimal": typeof lib_decimal;
  "lib/email": typeof lib_email;
  "lib/emailTemplates": typeof lib_emailTemplates;
  "lib/errors": typeof lib_errors;
  "lib/ids": typeof lib_ids;
  "lib/inventory": typeof lib_inventory;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/sequence": typeof lib_sequence;
  "lib/staff": typeof lib_staff;
  "lib/time": typeof lib_time;
  members: typeof members;
  migration: typeof migration;
  orders: typeof orders;
  passwords: typeof passwords;
  products: typeof products;
  seed: typeof seed;
  session: typeof session;
  shelf: typeof shelf;
  statistics: typeof statistics;
  stock: typeof stock;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
