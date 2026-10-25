/**
 * FlowOps Postgres schema (Drizzle). Migrations live in /drizzle and are applied
 * with `npm run db:migrate`.
 *
 * - Better Auth core tables: user, session, account, verification, rate_limit
 * - Tenancy: organization (tenant), member (user ↔ org, role owner|admin|staff),
 *   team_invite (token invites, v2.1), staff_invite (legacy email-match invites)
 * - Booking data, all scoped by organization_id: service, booking, audit_entry, notification
 */
import { relations } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { DayHours } from "@/lib/booking/types";

// ───────────────────────────── Better Auth core ─────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  businessName: text("business_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// ───────────────────────────── Tenancy ─────────────────────────────

export type WeekHours = Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>; // 0 = Sunday

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  hours: jsonb("hours").$type<WeekHours>().notNull(),
  /** Public booking page on/off. */
  publicBooking: boolean("public_booking").notNull().default(true),
  /** Google Calendar (per-org OAuth). Refresh token is AES-GCM encrypted. */
  googleRefreshTokenEnc: text("google_refresh_token_enc"),
  googleCalendarId: text("google_calendar_id"),
  googleAccountEmail: text("google_account_email"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** owner | admin | staff. Plain text column (no DB enum), so adding "admin" needed no migration. */
    role: text("role", { enum: ["owner", "admin", "staff"] }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("member_user_unique").on(t.userId), index("member_org_idx").on(t.organizationId)],
);

export const staffInvite = pgTable(
  "staff_invite",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_invite_email_unique").on(t.email)],
);

/**
 * Token invites (v2.1). Only a SHA-256 hash of the token is stored; the raw token
 * exists only in the link shown to the inviter / emailed to the invitee.
 * Single-use (accepted_at), revocable (revoked_at), expiring (expires_at), scoped to one org.
 */
export const teamInvite = pgTable(
  "team_invite",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "staff"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("team_invite_token_hash_unique").on(t.tokenHash), index("team_invite_org_idx").on(t.organizationId, t.email)],
);

// ───────────────────────────── Booking data ─────────────────────────────

export const service = pgTable(
  "service",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category", { enum: ["appointment", "travel", "restaurant", "workforce"] }).notNull().default("appointment"),
    durationMin: integer("duration_min").notNull().default(60),
    resource: text("resource").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("service_org_idx").on(t.organizationId)],
);

export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customer: text("customer").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    category: text("category", { enum: ["appointment", "travel", "restaurant", "workforce"] }).notNull(),
    service: text("service").notNull(),
    resource: text("resource").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD (org local)
    time: text("time").notNull(), // HH:MM (org local)
    durationMin: integer("duration_min").notNull(),
    notes: text("notes"),
    status: text("status", { enum: ["confirmed", "cancelled"] }).notNull(),
    calendarEventId: text("calendar_event_id"),
    source: text("source", { enum: ["dashboard", "assistant", "public"] }).notNull().default("dashboard"),
    history: jsonb("history").$type<{ at: string; action: string; detail: string }[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("booking_org_date_idx").on(t.organizationId, t.date), index("booking_org_status_idx").on(t.organizationId, t.status)],
);

export const auditEntry = pgTable(
  "audit_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    action: text("action").notNull(),
    bookingId: text("booking_id"),
    agent: text("agent").notNull(),
    outcome: text("outcome").notNull(),
    detail: text("detail").notNull(),
    actor: text("actor"),
  },
  (t) => [index("audit_org_at_idx").on(t.organizationId, t.at)],
);

export const notification = pgTable(
  "notification",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    bookingId: text("booking_id").notNull(),
    recipient: text("recipient").notNull(),
    channel: text("channel").notNull(),
    subject: text("subject").notNull(),
    deliveryStatus: text("delivery_status").notNull(),
    detail: text("detail"),
  },
  (t) => [index("notification_org_at_idx").on(t.organizationId, t.at)],
);

// Relations (used by Better Auth joins and Drizzle relational queries)
export const userRelations = relations(user, ({ many }) => ({ sessions: many(session), accounts: many(account) }));
export const sessionRelations = relations(session, ({ one }) => ({ user: one(user, { fields: [session.userId], references: [user.id] }) }));
export const accountRelations = relations(account, ({ one }) => ({ user: one(user, { fields: [account.userId], references: [user.id] }) }));
