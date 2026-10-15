CREATE TABLE "input_manifests" (
	"id" uuid PRIMARY KEY,
	"manifest" jsonb NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "input_objects" (
	"workspace_id" uuid,
	"file_id" uuid,
	"principal_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"reference" jsonb NOT NULL,
	"state" text NOT NULL,
	"transfer_expires_at" timestamp with time zone NOT NULL,
	"retained_until" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"retention_ms" bigint NOT NULL,
	CONSTRAINT "input_objects_pkey" PRIMARY KEY("workspace_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "input_objects" ADD CONSTRAINT "input_objects_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "input_objects" ADD CONSTRAINT "input_objects_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "input_objects" ADD CONSTRAINT "input_objects_reservation_id_storage_reservations_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "storage_reservations"("id");