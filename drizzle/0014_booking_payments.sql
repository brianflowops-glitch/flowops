CREATE TABLE "booking_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text,
	"request" jsonb NOT NULL,
	"resource" text NOT NULL,
	"date" text NOT NULL,
	"time" text NOT NULL,
	"duration_min" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"payment_mode" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"checkout_session_id" text,
	"payment_intent_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"booking_id" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_connect_account" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_connect_account_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "payment_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "deposit_cents" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "deposit_percent" integer;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connect_account" ADD CONSTRAINT "stripe_connect_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_hold_org_date_idx" ON "booking_hold" USING btree ("organization_id","date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_hold_checkout_session_unique" ON "booking_hold" USING btree ("checkout_session_id");