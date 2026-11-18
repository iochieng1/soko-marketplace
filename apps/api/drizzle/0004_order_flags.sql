ALTER TABLE "orders" ADD COLUMN "flagged_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "flagged_at" timestamp with time zone;