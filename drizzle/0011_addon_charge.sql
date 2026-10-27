CREATE TABLE "addon_charge" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"addon_key" text NOT NULL,
	"price_id" text NOT NULL,
	"from_quantity" integer NOT NULL,
	"to_quantity" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_invoice_id" text,
	"stripe_credit_note_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addon_charge" ADD CONSTRAINT "addon_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addon_charge_stripe_invoice_unique" ON "addon_charge" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "addon_charge_org_status_idx" ON "addon_charge" USING btree ("organization_id","status");