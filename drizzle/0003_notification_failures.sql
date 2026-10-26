CREATE TABLE "notification_failure" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"channel" text NOT NULL,
	"tag" text NOT NULL,
	"target" text NOT NULL,
	"failure_kind" text NOT NULL,
	"detail" text,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_failure" ADD CONSTRAINT "notification_failure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_failure_org_created_idx" ON "notification_failure" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_failure_created_idx" ON "notification_failure" USING btree ("created_at");