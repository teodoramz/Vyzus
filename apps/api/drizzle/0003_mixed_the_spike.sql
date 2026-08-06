ALTER TYPE "public"."user_role" ADD VALUE 'viewer';--> statement-breakpoint
CREATE TABLE "user_app_access" (
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	CONSTRAINT "user_app_access_user_id_app_id_pk" PRIMARY KEY("user_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "alert_channels" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "user_app_access" ADD CONSTRAINT "user_app_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_app_access" ADD CONSTRAINT "user_app_access_app_id_applications_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;