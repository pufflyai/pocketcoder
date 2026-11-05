CREATE TABLE "export_objects" (
	"id" uuid PRIMARY KEY,
	"export_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"execution" jsonb NOT NULL,
	"reference" jsonb NOT NULL,
	"data" bytea,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "preview_grants" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"incarnation_id" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"access_revision" text NOT NULL,
	"previews" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ceiling_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lifetime" jsonb;--> statement-breakpoint
CREATE INDEX "export_objects_retention" ON "export_objects" ("expires_at");--> statement-breakpoint
CREATE INDEX "export_objects_workspace" ON "export_objects" ("workspace_id");--> statement-breakpoint
ALTER TABLE "storage_reservations" DROP CONSTRAINT "storage_reservations_purpose_check", ADD CONSTRAINT "storage_reservations_purpose_check" CHECK ("purpose" IN ('checkpoint-upload', 'checkpoint-index', 'backup', 'attachment', 'screenshot', 'export'));