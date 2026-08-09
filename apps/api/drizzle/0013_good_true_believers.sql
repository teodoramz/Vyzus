ALTER TABLE "applications" ADD COLUMN "parent_app_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_parent_app_id_applications_id_fk" FOREIGN KEY ("parent_app_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;