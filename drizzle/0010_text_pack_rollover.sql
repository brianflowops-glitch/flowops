ALTER TABLE "text_pack" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "text_pack" ADD COLUMN "texts_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "text_pack_org_expires_idx" ON "text_pack" USING btree ("organization_id","expires_at");