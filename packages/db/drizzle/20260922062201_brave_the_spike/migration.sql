ALTER TABLE "machine_keys" ADD COLUMN "issuance_request_id" text;--> statement-breakpoint
ALTER TABLE "machine_keys" ADD COLUMN "issuance_request_digest" text;--> statement-breakpoint
ALTER TABLE "machine_keys" ADD COLUMN "managed_principal_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purge_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_keys" ADD CONSTRAINT "machine_keys_principal_id_issuance_request_id_unique" UNIQUE("principal_id","issuance_request_id");--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT "workspace_operations_kind_check", ADD CONSTRAINT "workspace_operations_kind_check" CHECK ("kind" IN ('preserve', 'restore', 'verify', 'delete', 'purge'));