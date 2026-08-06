CREATE TYPE "public"."alert_event" AS ENUM('down', 'recovered');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('slack', 'discord', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."check_type" AS ENUM('uptime', 'journey');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('passed', 'failed', 'error', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'manual', 'screenshot');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'editor');--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "channel_type" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"all_apps" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid,
	"channel_id" uuid NOT NULL,
	"event" "alert_event" NOT NULL,
	"status" "delivery_status" NOT NULL,
	"attempts" integer NOT NULL,
	"response_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_alert_channels" (
	"app_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "app_alert_channels_app_id_channel_id_pk" PRIMARY KEY("app_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"landing_url" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"auth_config_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"type" "check_type" NOT NULL,
	"name" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"failure_threshold" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_status" "run_status",
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checks_interval_min_chk" CHECK ("checks"."interval_minutes" >= 1)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"opening_run_id" uuid,
	"resolving_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"status" "run_status" NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"metrics" jsonb,
	"error_message" text,
	"screenshot_path" text,
	"trace_path" text,
	"worker_id" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"refresh_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_alert_channels" ADD CONSTRAINT "app_alert_channels_app_id_applications_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_alert_channels" ADD CONSTRAINT "app_alert_channels_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_app_id_applications_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_opening_run_id_runs_id_fk" FOREIGN KEY ("opening_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolving_run_id_runs_id_fk" FOREIGN KEY ("resolving_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checks_app_id_idx" ON "checks" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_check_idx" ON "incidents" USING btree ("check_id") WHERE "incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "incidents_check_idx" ON "incidents" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX "runs_check_started_idx" ON "runs" USING btree ("check_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_check_failed_idx" ON "runs" USING btree ("check_id") WHERE "runs"."status" <> 'passed';