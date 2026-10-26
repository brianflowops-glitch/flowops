ALTER TABLE "notification" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "sweep_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_status_at_idx" ON "notification" USING btree ("delivery_status","at");