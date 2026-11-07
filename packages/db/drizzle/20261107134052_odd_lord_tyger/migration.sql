CREATE TABLE "managed_capacity" (
	"workspace_id" uuid PRIMARY KEY,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_inputs" (
	"principal_id" uuid,
	"session_id" uuid,
	"input_id" uuid,
	"reference" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_inputs_pkey" PRIMARY KEY("principal_id","session_id","input_id")
);
--> statement-breakpoint
ALTER TABLE "input_objects" DROP CONSTRAINT "input_objects_workspace_id_workspaces_id_fkey";--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD COLUMN "managed" jsonb;--> statement-breakpoint
ALTER TABLE "export_objects" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "export_objects" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "input_objects" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "next_request_sequence" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_inputs" ADD CONSTRAINT "session_inputs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");