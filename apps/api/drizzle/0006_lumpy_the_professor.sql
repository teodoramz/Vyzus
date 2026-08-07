ALTER TABLE "checks" DROP CONSTRAINT "checks_current_screenshot_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "checks" DROP COLUMN "current_screenshot_run_id";--> statement-breakpoint
ALTER TABLE "checks" DROP COLUMN "current_screenshot_path";