CREATE TABLE "conversation_records" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_ref" uuid NOT NULL,
	"record_seq" integer NOT NULL,
	"record_key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"first_seq" bigint NOT NULL,
	"last_seq" bigint NOT NULL,
	"status" text NOT NULL,
	"document" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_records_seq" UNIQUE("conversation_ref","record_seq"),
	CONSTRAINT "conversation_records_key" UNIQUE("conversation_ref","record_key")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"conversation_id" uuid,
	"workspace_id" uuid NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"retention_set" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversations_identity" UNIQUE("principal_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_conversations" ADD COLUMN "bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_records_messages" ON "conversation_records" ("conversation_ref","last_seq");--> statement-breakpoint
CREATE INDEX "conversation_records_workspace" ON "conversation_records" ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_workspace_unidentified" ON "conversations" ("workspace_id") WHERE "conversation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "conversations_workspace" ON "conversations" ("workspace_id");--> statement-breakpoint
ALTER TABLE "conversation_records" ADD CONSTRAINT "conversation_records_conversation_ref_conversations_id_fkey" FOREIGN KEY ("conversation_ref") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_records" ADD CONSTRAINT "conversation_records_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");