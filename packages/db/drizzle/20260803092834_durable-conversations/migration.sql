CREATE TABLE "workspace_conversation_messages" (
	"workspace_id" uuid,
	"seq" bigint,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_conversation_messages_pkey" PRIMARY KEY("workspace_id","seq"),
	CONSTRAINT "workspace_conversation_messages_workspace_id_message_id_unique" UNIQUE("workspace_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_conversations" (
	"workspace_id" uuid PRIMARY KEY,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_conversation_messages" ADD CONSTRAINT "workspace_conversation_messages_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_conversations" ADD CONSTRAINT "workspace_conversations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");