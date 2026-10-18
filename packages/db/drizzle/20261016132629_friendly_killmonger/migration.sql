ALTER TABLE "conversation_requests" ADD COLUMN "execution" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "process_execution" jsonb;