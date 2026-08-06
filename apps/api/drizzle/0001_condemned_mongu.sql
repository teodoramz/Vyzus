ALTER TABLE "checks" ADD COLUMN "current_screenshot_run_id" uuid;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "current_screenshot_path" text;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_current_screenshot_run_id_runs_id_fk" FOREIGN KEY ("current_screenshot_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;