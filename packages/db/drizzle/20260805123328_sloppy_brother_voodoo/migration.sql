CREATE TABLE "workspace_terminal_sessions" (
	"session_id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"exit_code" integer,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_terminal_sessions_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN ('exit', 'idle', 'checkpoint', 'workspace_ended', 'agent_detached', 'client_closed'))
);
--> statement-breakpoint
CREATE INDEX "workspace_terminal_sessions_page" ON "workspace_terminal_sessions" ("workspace_id","opened_at","session_id");--> statement-breakpoint
ALTER TABLE "workspace_terminal_sessions" ADD CONSTRAINT "workspace_terminal_sessions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_terminal_sessions" ADD CONSTRAINT "workspace_terminal_sessions_key_id_machine_keys_id_fkey" FOREIGN KEY ("key_id") REFERENCES "machine_keys"("id");
