CREATE TABLE "conversation_requests" (
	"principal_id" uuid,
	"conversation_id" uuid,
	"request_id" uuid,
	"identity" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_requests_pkey" PRIMARY KEY("principal_id","conversation_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_conversation_messages" ADD COLUMN "identity" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");