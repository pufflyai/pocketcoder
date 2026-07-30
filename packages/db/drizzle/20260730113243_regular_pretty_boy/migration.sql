CREATE TABLE "workspace_checkpoints" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"storage_id" uuid NOT NULL,
	"parent_checkpoint_id" uuid,
	"state" text NOT NULL,
	"reason_code" text,
	"provider_kind" text NOT NULL,
	"provider_ref" jsonb,
	"template_snapshot" jsonb NOT NULL,
	"template_digest" text NOT NULL,
	"source_provenance" jsonb,
	"manifest" jsonb,
	"manifest_digest" text,
	"logical_bytes" bigint,
	"stored_bytes" bigint,
	"file_count" bigint,
	"conversation_restore" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_operations" (
	"id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"workspace_id" uuid,
	"checkpoint_id" uuid,
	"result_workspace_id" uuid,
	"reason_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_operations_principal_id_kind_idempotency_key_unique" UNIQUE("principal_id","kind","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "workspace_outputs" (
	"workspace_id" uuid,
	"seq" bigint,
	"name" text NOT NULL,
	"value" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_outputs_pkey" PRIMARY KEY("workspace_id","seq")
);
--> statement-breakpoint
CREATE TABLE "workspace_storage" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_ref" jsonb NOT NULL,
	"state" text NOT NULL,
	"mount_manifest" jsonb NOT NULL,
	"logical_bytes" bigint,
	"file_count" bigint,
	"retained_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_error_code" text
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "origin_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "restored_from_checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "source_descriptor" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "resolved_source" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "persistence_capability" text DEFAULT 'filesystem_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "latest_checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "launch_mode" text DEFAULT 'create' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "outputs" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
DROP INDEX "workspaces_principal_external_active";--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_principal_external_active" ON "workspaces" ("principal_id","external_id") WHERE "state" NOT IN ('succeeded', 'failed', 'canceled', 'expired', 'preserved');--> statement-breakpoint
DROP INDEX "workspaces_deadline";--> statement-breakpoint
CREATE INDEX "workspaces_deadline" ON "workspaces" ("deadline_at") WHERE "state" NOT IN ('succeeded', 'failed', 'canceled', 'expired', 'preserved');--> statement-breakpoint
CREATE INDEX "workspace_checkpoints_principal_state" ON "workspace_checkpoints" ("principal_id","state","created_at");--> statement-breakpoint
CREATE INDEX "workspace_checkpoints_gc" ON "workspace_checkpoints" ("state","expires_at");--> statement-breakpoint
CREATE INDEX "workspace_operations_due" ON "workspace_operations" ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_storage_one_live" ON "workspace_storage" ("workspace_id") WHERE "state" NOT IN ('deleted', 'lost', 'quarantined');--> statement-breakpoint
CREATE INDEX "workspace_storage_gc" ON "workspace_storage" ("state","retained_until");--> statement-breakpoint
CREATE INDEX "workspace_storage_principal" ON "workspace_storage" ("principal_id");--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_storage_id_workspace_storage_id_fkey" FOREIGN KEY ("storage_id") REFERENCES "workspace_storage"("id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_fBJ1lkBRI011_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "workspace_checkpoints"("id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_result_workspace_id_workspaces_id_fkey" FOREIGN KEY ("result_workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_outputs" ADD CONSTRAINT "workspace_outputs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");