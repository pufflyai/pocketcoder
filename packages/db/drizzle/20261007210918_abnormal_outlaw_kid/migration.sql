CREATE TABLE "checkpoint_transfers" (
	"id" uuid PRIMARY KEY,
	"operation_id" uuid NOT NULL,
	"checkpoint_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"state" text NOT NULL,
	"request_digest" text NOT NULL,
	"grant_digest" bytea,
	"expires_at" timestamp with time zone NOT NULL,
	"reservation_id" uuid,
	"stage_path" text,
	"stage_identity" jsonb,
	"declared_header" jsonb,
	"expected_archive_bytes" bigint,
	"summary" jsonb,
	"archive_digest" text,
	"stored_bytes" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "checkpoint_transfers_direction_check" CHECK ("direction" IN ('upload', 'download')),
	CONSTRAINT "checkpoint_transfers_state_check" CHECK ("state" IN ('preparing', 'granted', 'streaming', 'validated', 'publishing', 'complete', 'cleanup_pending', 'aborted')),
	CONSTRAINT "checkpoint_transfers_epoch_check" CHECK ("connection_epoch" >= 0),
	CONSTRAINT "checkpoint_transfers_digest_check" CHECK ("grant_digest" IS NULL OR octet_length("grant_digest") = 32),
	CONSTRAINT "checkpoint_transfers_size_check" CHECK (
      ("expected_archive_bytes" IS NULL OR "expected_archive_bytes" BETWEEN 0 AND 9007199254740991) AND
      ("stored_bytes" IS NULL OR "stored_bytes" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "checkpoint_transfers_grant_phase_check" CHECK (
      ("state" = 'granted' AND "grant_digest" IS NOT NULL) OR
      ("state" <> 'granted' AND "grant_digest" IS NULL)),
	CONSTRAINT "checkpoint_transfers_upload_reservation_check" CHECK (
      "direction" <> 'upload' OR "state" = 'preparing' OR "reservation_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "checkpoint_controller_state" (
	"id" text PRIMARY KEY,
	"source_writer" jsonb,
	"recovery" jsonb
);
--> statement-breakpoint
CREATE TABLE "storage_reservations" (
	"id" uuid PRIMARY KEY,
	"purpose" text NOT NULL,
	"operation_id" uuid,
	"workspace_id" uuid,
	"principal_id" uuid,
	"state" text NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"reserved_files" bigint NOT NULL,
	"materialized_bytes" bigint DEFAULT 0 NOT NULL,
	"materialized_files" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "storage_reservations_purpose_check" CHECK ("purpose" IN ('checkpoint-upload', 'checkpoint-index', 'backup', 'attachment', 'screenshot')),
	CONSTRAINT "storage_reservations_state_check" CHECK ("state" IN ('reserved', 'committed', 'releasing', 'released')),
	CONSTRAINT "storage_reservations_bounds_check" CHECK (
      "reserved_bytes" BETWEEN 0 AND 9007199254740991 AND
      "reserved_files" BETWEEN 0 AND 9007199254740991 AND
      "materialized_bytes" BETWEEN 0 AND "reserved_bytes" AND
      "materialized_files" BETWEEN 0 AND "reserved_files"),
	CONSTRAINT "storage_reservations_workspace_owner_check" CHECK ("workspace_id" IS NULL OR "principal_id" IS NOT NULL),
	CONSTRAINT "storage_reservations_checkpoint_owner_check" CHECK (
      "purpose" NOT IN ('checkpoint-upload', 'checkpoint-index') OR
      ("operation_id" IS NOT NULL AND "workspace_id" IS NOT NULL AND "principal_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_transfers_one_live_attempt" ON "checkpoint_transfers" ("operation_id","direction") WHERE "state" NOT IN ('complete', 'aborted');--> statement-breakpoint
CREATE INDEX "checkpoint_transfers_workspace" ON "checkpoint_transfers" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "checkpoint_transfers_reconcile" ON "checkpoint_transfers" ("state","updated_at");--> statement-breakpoint
CREATE INDEX "storage_reservations_active" ON "storage_reservations" ("state","expires_at");--> statement-breakpoint
CREATE INDEX "storage_reservations_workspace" ON "storage_reservations" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "storage_reservations_principal" ON "storage_reservations" ("principal_id","state");--> statement-breakpoint
ALTER TABLE "checkpoint_transfers" ADD CONSTRAINT "checkpoint_transfers_operation_id_workspace_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "workspace_operations"("id");--> statement-breakpoint
ALTER TABLE "checkpoint_transfers" ADD CONSTRAINT "checkpoint_transfers_LwO6aZRv7ni4_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "workspace_checkpoints"("id");--> statement-breakpoint
ALTER TABLE "checkpoint_transfers" ADD CONSTRAINT "checkpoint_transfers_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "checkpoint_transfers" ADD CONSTRAINT "checkpoint_transfers_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "checkpoint_transfers" ADD CONSTRAINT "checkpoint_transfers_ioeVcqFKXesW_fkey" FOREIGN KEY ("reservation_id") REFERENCES "storage_reservations"("id");--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_operation_id_workspace_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "workspace_operations"("id");--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");