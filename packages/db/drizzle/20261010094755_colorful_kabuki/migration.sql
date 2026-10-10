CREATE TABLE "binary_outputs" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL UNIQUE,
	"connection_epoch" integer NOT NULL,
	"state" text NOT NULL,
	"grant_digest" bytea,
	"data" bytea,
	"bytes" integer,
	"digest" text,
	"expires_at" timestamp with time zone NOT NULL,
	"retained_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "binary_outputs_state" CHECK ("state" IN ('capturing','ready','deleted')),
	CONSTRAINT "binary_outputs_size" CHECK ("data" IS NULL OR octet_length("data") BETWEEN 1 AND 4194304),
	CONSTRAINT "binary_outputs_content" CHECK (("state" = 'ready') = ("data" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "binary_outputs_workspace" ON "binary_outputs" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "binary_outputs_expiry" ON "binary_outputs" ("state","expires_at","retained_until");--> statement-breakpoint
ALTER TABLE "binary_outputs" ADD CONSTRAINT "binary_outputs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "binary_outputs" ADD CONSTRAINT "binary_outputs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "binary_outputs" ADD CONSTRAINT "binary_outputs_key_id_machine_keys_id_fkey" FOREIGN KEY ("key_id") REFERENCES "machine_keys"("id");--> statement-breakpoint
ALTER TABLE "binary_outputs" ADD CONSTRAINT "binary_outputs_reservation_id_storage_reservations_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "storage_reservations"("id");