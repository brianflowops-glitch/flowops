CREATE TABLE "message_delivery_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"detail" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_opt_out" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out" boolean NOT NULL,
	"keyword" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_delivery_event_msg_idx" ON "message_delivery_event" USING btree ("provider","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhook_event_key_uq" ON "provider_webhook_event" USING btree ("provider","event_key");