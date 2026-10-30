CREATE TABLE "text_pack_revocation" (
	"id" text PRIMARY KEY NOT NULL,
	"text_pack_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"stripe_charge_id" text NOT NULL,
	"reason" text,
	"texts_total" integer NOT NULL,
	"texts_used" integer NOT NULL,
	"texts_revoked_before" integer NOT NULL,
	"texts_revoked_after" integer NOT NULL,
	"texts_used_over_revocation" integer DEFAULT 0 NOT NULL,
	"amount_refunded" integer DEFAULT 0 NOT NULL,
	"dispute_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "texts_revoked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "amount_refunded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "dispute_status" text;--> statement-breakpoint
ALTER TABLE "text_pack_revocation" ADD CONSTRAINT "text_pack_revocation_text_pack_id_text_pack_id_fk" FOREIGN KEY ("text_pack_id") REFERENCES "public"."text_pack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_pack_revocation" ADD CONSTRAINT "text_pack_revocation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "text_pack_revocation_event_unique" ON "text_pack_revocation" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "text_pack_revocation_pack_idx" ON "text_pack_revocation" USING btree ("text_pack_id");