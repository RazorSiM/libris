/**
 * Better Auth's core tables.
 *
 * ⚠︎ These definitions must agree with what Better Auth resolves from the
 * options in lib/auth.ts. They were written against `getAuthTables()` — Better
 * Auth's own resolved definition — rather than the docs, and must be re-checked
 * on every upgrade. Dump `getAuthTables()` again after an upgrade and diff.
 *
 * Two things about how the Drizzle adapter binds to this file:
 *
 * 1. It resolves a model by `schema[modelName]`, i.e. against the EXPORT NAMES
 *    here, not the SQL table names. That is why these are exported as `users`,
 *    `sessions`, `accounts` and `verifications` to match the `modelName` values
 *    in lib/auth.ts. Renaming an export silently breaks auth at runtime.
 * 2. Within a table it resolves fields by the JavaScript PROPERTY KEY, not the
 *    column name. So the keys stay camelCase (`emailVerified`) while the
 *    columns are snake_case (`email_verified`), which is both what the adapter
 *    wants and what the rest of schema.ts does.
 *
 * Kept in its own file rather than appended to schema.ts so that upgrade diffs
 * touch only auth tables.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Better Auth generates its own ids (see `advanced.database.generateId` in
// lib/auth.ts, left at the default), so `id` is a plain text primary key with
// no database-side default rather than uuid/defaultRandom like the older tables.
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Added by the admin plugin. `role` is nullable upstream; new users get
    // "user" from the plugin's defaultRole rather than a column default.
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
  },
  (t) => [
    // Unique, not merely indexed: two accounts sharing an email would make
    // sign-in ambiguous. Hit on every sign-in.
    uniqueIndex("users_email_uniq").on(t.email),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Added by the admin plugin: set when an admin is impersonating this user.
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [
    // Looked up on every authenticated request, so this one is load-bearing.
    uniqueIndex("sessions_token_uniq").on(t.token),
    // Listing and bulk-revoking a user's devices.
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // The password hash for email+password accounts (providerId "credential").
    // Hashes live here, never on users.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Not unique: Better Auth writes one row per issued token, so the same
  // identifier legitimately appears more than once.
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * The apiKey plugin's table — Libris' app passwords for OPDS and e-reader
 * clients.
 *
 * Two naming constraints meet here and neither is negotiable:
 *
 *   - the adapter resolves the model by `schema[modelName]`, i.e. the EXPORT
 *     name, so the export must be `apiKeys` and lib/auth.ts must pass
 *     `modelName: "apiKeys"`;
 *   - the SQL table name comes from pgTable(), so it stays `api_keys`.
 *
 * Ownership is `referenceId`, NOT `userId`: 1.6 made it polymorphic so a key
 * can belong to a user or an organization. Libris only ever has users, so the
 * foreign key to users.id is safe to declare — revisit it if the organization
 * plugin is ever adopted (it is a hard non-goal today).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    // Multi-configuration support. Libris registers a single configuration, so
    // every row is "default"; the plugin still filters on it in every lookup.
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    // First few characters of the plaintext key, shown in the UI so a user can
    // tell two app passwords apart without revealing either.
    start: text("start"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    // The HASHED key (SHA-256, base64url). Never the plaintext.
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    // Milliseconds. `integer` matches Better Auth's own generated schema; it
    // caps the window at ~24.8 days, which is far beyond any sane value.
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    permissions: text("permissions"),
    // JSON, but declared `string` upstream: the plugin stringifies on the way
    // in and parses on the way out via a field transform.
    metadata: text("metadata"),
  },
  (t) => [
    // Deliberately stricter than upstream, which declares a plain index. Two
    // rows sharing a hash would make verifyApiKey's findOne ambiguous, and the
    // hash of a random secret can only collide through a bug.
    uniqueIndex("api_keys_key_uniq").on(t.key),
    index("api_keys_reference_id_idx").on(t.referenceId),
    index("api_keys_config_id_idx").on(t.configId),
  ],
);
