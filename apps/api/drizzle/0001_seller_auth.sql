CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- Sellers created before auth existed (the dev seed) get "!", which is not a
-- valid argon2 hash, so nobody can log in as them until a password is set.
-- Hand-edited: drizzle-kit would add the NOT NULL column with no default,
-- which fails on a table that already has rows.
ALTER TABLE "sellers" ADD COLUMN "password_hash" text NOT NULL DEFAULT '!';--> statement-breakpoint
ALTER TABLE "sellers" ALTER COLUMN "password_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");