CREATE TABLE "warm_pool_runtimes" (
	"id" uuid PRIMARY KEY,
	"template_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"template_version" text NOT NULL,
	"template_digest" text NOT NULL,
	"driver_kind" text NOT NULL,
	"eligibility_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"provider_ref" jsonb,
	"enrollment_digest" bytea,
	"enrollment_expires_at" timestamp with time zone,
	"workspace_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"leased_at" timestamp with time zone,
	"failure_code" text
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "provisioning_mode" text;--> statement-breakpoint
CREATE INDEX "warm_pool_eligible" ON "warm_pool_runtimes" ("template_digest","driver_kind","eligibility_fingerprint","state","ready_at");--> statement-breakpoint
CREATE UNIQUE INDEX "warm_pool_workspace_once" ON "warm_pool_runtimes" ("workspace_id");--> statement-breakpoint
ALTER TABLE "warm_pool_runtimes" ADD CONSTRAINT "warm_pool_runtimes_template_id_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id");--> statement-breakpoint
ALTER TABLE "warm_pool_runtimes" ADD CONSTRAINT "warm_pool_runtimes_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");