CREATE TABLE "subscription_item" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"stripe_item_id" text NOT NULL,
	"price_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_item" ADD CONSTRAINT "subscription_item_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_item_stripe_item_unique" ON "subscription_item" USING btree ("stripe_item_id");--> statement-breakpoint
CREATE INDEX "subscription_item_subscription_idx" ON "subscription_item" USING btree ("subscription_id");