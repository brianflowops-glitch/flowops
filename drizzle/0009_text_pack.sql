CREATE TABLE "text_pack" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"pack_key" text NOT NULL,
	"texts_per_pack" integer NOT NULL,
	"quantity" integer NOT NULL,
	"stripe_invoice_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_paid" integer,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "text_pack" ADD CONSTRAINT "text_pack_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "text_pack_stripe_invoice_unique" ON "text_pack" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "text_pack_org_period_idx" ON "text_pack" USING btree ("organization_id","period_start");