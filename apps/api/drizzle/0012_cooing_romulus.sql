ALTER TYPE "public"."check_type" ADD VALUE 'push';--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_ping_at" timestamp with time zone;