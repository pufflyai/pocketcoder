ALTER TABLE "workspaces" ADD COLUMN "agent_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "change_seq" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "failure_log_tail" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "failure_log_tail_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "failure_last_log_seq" bigint;