/**
 * FlowOps Postgres schema (Drizzle). Migrations live in /drizzle and are applied
 * with `npm run db:migrate`.
 *
 * - Better Auth core tables: user, session, account, verification, rate_limit
 * - Tenancy: organization (tenant), member (user ↔ org, role owner|admin|staff),
 *   team_invite (token invites, v2.1), staff_invite (legacy email-match invites)
 * - Booking data, all scoped by organization_id: service, booking, audit_entry, notification
 * - Reliability: notification_failure (final send failures after retries; redacted),
 *   provider_webhook_event (dedupe), message_delivery_event, sms_opt_out
 */
import { relations } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { DayHours } from "@/lib/booking/types";
import { phoneE164Sql } from "./phone-sql";

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
    /** Customer opted in to appointment texts (A2P 10DLC consent record). */
    smsConsent: boolean("sms_consent").notNull().default(false),
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
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
  (t) => [
    index("booking_org_date_idx").on(t.organizationId, t.date),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    /** STOP/START match on the normalized phone (migration 0007). Must stay identical to the query's phoneE164Sql. */
    index("booking_phone_e164_idx").on(phoneE164Sql(t.phone)),
  ],
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
    /** v2.4 sweeper lease: set atomically when the recovery cron claims a stale "queued" row. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** v2.4: how many times the recovery cron has claimed this row (capped, so it can't loop). */
    sweepAttempts: integer("sweep_attempts").notNull().default(0),
  },
  (t) => [index("notification_org_at_idx").on(t.organizationId, t.at), index("notification_status_at_idx").on(t.deliveryStatus, t.at)],
);

/**
 * Final outbound-notification failures (after retries), v2.4. Additive only.
 * Never stores message bodies, links or full contact details: `target` is masked (•••1234 / j•••@example.com)
 * and `detail` is scrubbed of links, emails and phone numbers. organization_id is null for account emails.
 */
export const notificationFailure = pgTable(
  "notification_failure",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // "sms" | "email"
    tag: text("tag").notNull(), // e.g. "booking:BK-123", "account_email"
    target: text("target").notNull(), // redacted
    failureKind: text("failure_kind").notNull(), // "permanent" | "transient_exhausted" | "ambiguous"
    detail: text("detail"),
    attempts: integer("attempts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_failure_org_created_idx").on(t.organizationId, t.createdAt), index("notification_failure_created_idx").on(t.createdAt)],
);

/** Inbound provider webhook dedupe (v2.4): one row per (provider, event key); a replay hits the unique index. */
export const providerWebhookEvent = pgTable(
  "provider_webhook_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(), // "twilio" | "resend"
    eventKey: text("event_key").notNull(), // Twilio MessageSid[:MessageStatus], Resend svix-id
    eventType: text("event_type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_webhook_event_key_uq").on(t.provider, t.eventKey)],
);

/** Delivery status callbacks (Twilio StatusCallback, Resend email.* events). Append-only. */
export const messageDeliveryEvent = pgTable(
  "message_delivery_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    messageId: text("message_id").notNull(), // Twilio SM…/MM… sid or Resend email id
    status: text("status").notNull(), // e.g. delivered, undelivered, failed, email.bounced
    errorCode: text("error_code"),
    detail: text("detail"), // scrubbed
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_delivery_event_msg_idx").on(t.provider, t.messageId)],
);

/**
 * Carrier-level SMS opt-out state per phone (E.164) for the FlowOps sender. STOP applies to every org that
 * texts from the shared number, so this is not org-scoped. Checked before every outbound SMS.
 */
export const smsOptOut = pgTable("sms_opt_out", {
  phone: text("phone").primaryKey(),
  optedOut: boolean("opted_out").notNull(),
  keyword: text("keyword").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Relations (used by Better Auth joins and Drizzle relational queries)
export const userRelations = relations(user, ({ many }) => ({ sessions: many(session), accounts: many(account) }));
export const sessionRelations = relations(session, ({ one }) => ({ user: one(user, { fields: [session.userId], references: [user.id] }) }));
export const accountRelations = relations(account, ({ one }) => ({ user: one(user, { fields: [account.userId], references: [user.id] }) }));

// ───────────────────────────── Billing (Stripe, v2.4, additive 0006) ─────────────────────────────
// See docs/BILLING.md. Stripe is the source of truth; these rows mirror it from webhooks.
// Plain text status column (no DB enum), matching the member.role convention.

/** One Stripe customer per organization. */
export const billingCustomer = pgTable(
  "billing_customer",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("billing_customer_stripe_customer_unique").on(t.stripeCustomerId)],
);

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Mirror of a Stripe subscription, scoped to one organization. */
export const subscription = pgTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
    /** Stripe price id (price_…); mapped to a plan key via STRIPE_PRICE_* env vars. */
    priceId: text("price_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** `created` of the Stripe event that last wrote this row (out-of-order guard). */
    lastEventCreated: timestamp("last_event_created", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscription_stripe_subscription_unique").on(t.stripeSubscriptionId), index("subscription_org_idx").on(t.organizationId)],
);

/**
 * Line items of a mirrored Stripe subscription (v2.5, additive 0008): the plan item and any add-ons.
 * Rewritten wholesale from the fetched subscription by the same guarded write as `subscription`, so
 * ordering/dedupe are inherited. Whether an item is the plan or an add-on is derived at read time
 * from price id ↔ env config (STRIPE_PRICE_* / STRIPE_ADDON_PRICE_*), like subscription.price_id.
 */
export const subscriptionItem = pgTable(
  "subscription_item",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscription.id, { onDelete: "cascade" }),
    stripeItemId: text("stripe_item_id").notNull(),
    priceId: text("price_id"),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscription_item_stripe_item_unique").on(t.stripeItemId), index("subscription_item_subscription_idx").on(t.subscriptionId)],
);

/**
 * One-time text packs (additive 0009). A row is reserved `pending` before the invoice is charged and only
 * `paid` rows grant texts (entitlements: plan texts + paid packs whose window contains now). `period_start` /
 * `period_end` is the monthly text window the pack is valid for (the billing period; for annual subscriptions
 * the current month inside the year), also the unit of the per-period cap. `stripe_invoice_id` is unique, which
 * is the dedupe key for invoice.paid / invoice.payment_failed.
 * Rollover (additive 0010): `expires_at` = end of the window AFTER the purchase window (a pack bought in window N is
 * usable in N and N+1; null on older rows = `period_end`). `texts_used` counts texts drawn from the pack
 * (plan allowance first, then packs soonest-expiring first; see consumeTexts in text-packs.ts).
 */
export const TEXT_PACK_STATUSES = ["pending", "paid", "failed"] as const;
export type TextPackStatus = (typeof TEXT_PACK_STATUSES)[number];
export const textPack = pgTable(
  "text_pack",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Pack key, e.g. texts_1000. */
    packKey: text("pack_key").notNull(),
    textsPerPack: integer("texts_per_pack").notNull(),
    quantity: integer("quantity").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    status: text("status", { enum: TEXT_PACK_STATUSES }).notNull().default("pending"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** What Stripe collected, in the smallest currency unit (set when paid). */
    amountPaid: integer("amount_paid"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last instant the pack's texts are usable: end of the next text window (rollover, 0010). Null = period_end. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Texts already drawn from this pack (0..texts_per_pack × quantity). */
    textsUsed: integer("texts_used").notNull().default(0),
    /**
     * Clawback (additive 0012): texts taken back after a refund or dispute of the pack's charge. Set ABSOLUTELY from
     * Stripe's current state on every charge.refunded / charge.dispute.* event (never incremented), capped so the
     * texts already used are never "revoked". Usable texts = texts_per_pack × quantity − texts_used − texts_revoked.
     */
    textsRevoked: integer("texts_revoked").notNull().default(0),
    /** When texts were first revoked (null when nothing is revoked, e.g. after a won dispute restored them). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** refund | partial_refund | dispute | dispute_lost | restored_dispute_won. */
    revokedReason: text("revoked_reason"),
    /** The charge that paid the pack invoice (learnt from the first refund/dispute event). */
    stripeChargeId: text("stripe_charge_id"),
    /** charge.amount_refunded at the last processed event (cumulative, smallest currency unit). */
    amountRefunded: integer("amount_refunded").notNull().default(0),
    /** Status of the charge's latest dispute at the last processed event (null = never disputed). */
    disputeStatus: text("dispute_status"),
  },
  (t) => [
    uniqueIndex("text_pack_stripe_invoice_unique").on(t.stripeInvoiceId),
    index("text_pack_org_period_idx").on(t.organizationId, t.periodStart),
    index("text_pack_org_expires_idx").on(t.organizationId, t.expiresAt),
  ],
);

/**
 * One processed refund/dispute event of a text pack's charge (additive 0012): the audit trail of a clawback, and
 * where texts that were ALREADY USED when the pack was revoked are recorded for Brian (`texts_used_over_revocation`:
 * texts that would have been revoked but had already been sent; they are not taken back and nothing is charged).
 * `stripe_event_id` is unique, so a repeated delivery never adds a second row.
 */
export const textPackRevocation = pgTable(
  "text_pack_revocation",
  {
    id: text("id").primaryKey(),
    textPackId: text("text_pack_id")
      .notNull()
      .references(() => textPack.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    stripeChargeId: text("stripe_charge_id").notNull(),
    reason: text("reason"),
    textsTotal: integer("texts_total").notNull(),
    textsUsed: integer("texts_used").notNull(),
    textsRevokedBefore: integer("texts_revoked_before").notNull(),
    textsRevokedAfter: integer("texts_revoked_after").notNull(),
    textsUsedOverRevocation: integer("texts_used_over_revocation").notNull().default(0),
    amountRefunded: integer("amount_refunded").notNull().default(0),
    disputeStatus: text("dispute_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("text_pack_revocation_event_unique").on(t.stripeEventId), index("text_pack_revocation_pack_idx").on(t.textPackId)],
);

/** Processed Stripe webhook events (idempotency: Stripe retries and may deliver an event more than once). */
export const stripeEvent = pgTable("stripe_event", {
  id: text("id").primaryKey(), // evt_…
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One attempt to charge a trial add-on increase (docs/BILLING.md §11, patch 0005). Written `pending` before any
 * Stripe call so a crash between the charge and the add-on being applied can be settled (refund or confirm) by
 * `reconcileAddonCharges` / `sweepAddonCharges`. Statuses: pending → paid → applied | refunded; pending → failed.
 */
export const ADDON_CHARGE_STATUSES = ["pending", "paid", "applied", "failed", "refunded"] as const;
export const addonCharge = pgTable(
  "addon_charge",
  {
    /** Attempt id (adc_…); also in the invoice metadata (`flowops_addon_charge_id`) and the idempotency key. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    addonKey: text("addon_key").notNull(),
    priceId: text("price_id").notNull(),
    fromQuantity: integer("from_quantity").notNull(),
    toQuantity: integer("to_quantity").notNull(),
    /** What we asked Stripe to collect, smallest currency unit. */
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    paymentMethod: text("payment_method").notNull(),
    status: text("status", { enum: ADDON_CHARGE_STATUSES }).notNull().default("pending"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeCreditNoteId: text("stripe_credit_note_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("addon_charge_stripe_invoice_unique").on(t.stripeInvoiceId), index("addon_charge_org_status_idx").on(t.organizationId, t.status)],
);
