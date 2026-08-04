CREATE TABLE "workspace_network_events" (
	"workspace_id" uuid,
	"seq" bigint,
	"source_session_id" uuid NOT NULL,
	"source_seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"decision" text NOT NULL,
	"transport" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"method" text,
	"path" text,
	"matched_rule" text,
	"reason" text NOT NULL,
	CONSTRAINT "workspace_network_events_pkey" PRIMARY KEY("workspace_id","seq"),
	CONSTRAINT "workspace_network_events_workspace_id_source_session_id_source_seq_unique" UNIQUE("workspace_id","source_session_id","source_seq")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "network_state" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "network_event_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "workspace_network_events_page" ON "workspace_network_events" ("workspace_id","seq");--> statement-breakpoint
ALTER TABLE "workspace_network_events" ADD CONSTRAINT "workspace_network_events_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_status_check" CHECK ("status" IN ('active', 'available', 'retired'));--> statement-breakpoint
ALTER TABLE "warm_pool_runtimes" ADD CONSTRAINT "warm_pool_runtimes_state_check" CHECK ("state" IN ('provisioning', 'ready', 'leasing', 'leased', 'draining', 'failed'));--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_state_check" CHECK ("state" IN ('creating', 'ready', 'failed', 'deleting', 'deleted'));--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_conversation_restore_check" CHECK ("conversation_restore" IN ('supported', 'filesystem_only', 'unknown'));--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_kind_check" CHECK ("kind" IN ('preserve', 'restore', 'verify', 'delete'));--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_state_check" CHECK ("state" IN ('pending', 'running', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "workspace_state_history" ADD CONSTRAINT "workspace_state_history_from_check" CHECK ("from_state" IS NULL OR "from_state" IN ('queued', 'provisioning', 'connected', 'ready', 'preserving', 'terminating', 'succeeded', 'failed', 'canceled', 'expired', 'preserved'));--> statement-breakpoint
ALTER TABLE "workspace_state_history" ADD CONSTRAINT "workspace_state_history_to_check" CHECK ("to_state" IN ('queued', 'provisioning', 'connected', 'ready', 'preserving', 'terminating', 'succeeded', 'failed', 'canceled', 'expired', 'preserved'));--> statement-breakpoint
ALTER TABLE "workspace_state_history" ADD CONSTRAINT "workspace_state_history_reason_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('child_exit_success', 'child_exit_failure', 'setup_failed', 'bootstrap_failed', 'registration_timeout', 'health_failed', 'child_crash', 'provider_lost', 'disconnect_timeout', 'canceled_by_caller', 'deadline_expired', 'idle_expired', 'queue_timeout', 'launch_failed', 'preserve_requested', 'preserved_by_policy', 'checkpoint_created', 'checkpoint_failed', 'checkpoint_corrupt', 'checkpoint_quota_exceeded', 'checkpoint_storage_lost', 'restore_requested', 'restore_failed', 'image_unavailable', 'source_resolution_failed', 'secret_resolution_failed', 'operation_conflict', 'network_policy_failed'));--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_state_check" CHECK ("state" IN ('allocating', 'ready', 'snapshotting', 'retained', 'restoring', 'deleting', 'deleted', 'lost', 'quarantined'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_state_check" CHECK ("state" IN ('queued', 'provisioning', 'connected', 'ready', 'preserving', 'terminating', 'succeeded', 'failed', 'canceled', 'expired', 'preserved'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('child_exit_success', 'child_exit_failure', 'setup_failed', 'bootstrap_failed', 'registration_timeout', 'health_failed', 'child_crash', 'provider_lost', 'disconnect_timeout', 'canceled_by_caller', 'deadline_expired', 'idle_expired', 'queue_timeout', 'launch_failed', 'preserve_requested', 'preserved_by_policy', 'checkpoint_created', 'checkpoint_failed', 'checkpoint_corrupt', 'checkpoint_quota_exceeded', 'checkpoint_storage_lost', 'restore_requested', 'restore_failed', 'image_unavailable', 'source_resolution_failed', 'secret_resolution_failed', 'operation_conflict', 'network_policy_failed'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_agent_state_check" CHECK ("agent_state" IN ('unknown', 'running', 'stable'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_network_state_check" CHECK ("network_state" IN ('disabled', 'starting', 'ready', 'degraded'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_terminal_intent_check" CHECK ("terminal_intent" IS NULL OR "terminal_intent" IN ('queued', 'provisioning', 'connected', 'ready', 'preserving', 'terminating', 'succeeded', 'failed', 'canceled', 'expired', 'preserved'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_provisioning_mode_check" CHECK ("provisioning_mode" IS NULL OR "provisioning_mode" IN ('cold', 'warm'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_launch_mode_check" CHECK ("launch_mode" IN ('create', 'restore'));