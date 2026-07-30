CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error_code" text
);
--> statement-breakpoint
CREATE TABLE "machine_keys" (
	"id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"secret_digest" bytea NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"scopes" text[] NOT NULL,
	"template_names" text[] NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL UNIQUE,
	"description" text,
	"spec" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "templates_name_version_unique" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "workspace_logs" (
	"workspace_id" uuid,
	"seq" bigint,
	"stream" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"content" bytea NOT NULL,
	CONSTRAINT "workspace_logs_pkey" PRIMARY KEY("workspace_id","seq")
);
--> statement-breakpoint
CREATE TABLE "workspace_state_history" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason_code" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"template_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"template_version" text NOT NULL,
	"template_digest" text NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"reason_code" text,
	"terminal_intent" text,
	"launch_input" jsonb,
	"provider_kind" text,
	"provider_ref" jsonb,
	"registration_digest" bytea,
	"registration_expires_at" timestamp with time zone,
	"reconnect_digest" bytea,
	"connection_epoch" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"launch_attempts" integer DEFAULT 0 NOT NULL,
	"health" jsonb DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "workspaces_principal_id_idempotency_key_unique" UNIQUE("principal_id","idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "event_outbox_due" ON "event_outbox" ("next_attempt_at") WHERE "delivered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workspace_state_history_ws" ON "workspace_state_history" ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_principal_external_active" ON "workspaces" ("principal_id","external_id") WHERE "state" NOT IN ('succeeded', 'failed', 'canceled', 'expired');--> statement-breakpoint
CREATE INDEX "workspaces_state_created" ON "workspaces" ("state","created_at");--> statement-breakpoint
CREATE INDEX "workspaces_deadline" ON "workspaces" ("deadline_at") WHERE "state" NOT IN ('succeeded', 'failed', 'canceled', 'expired');--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "machine_keys" ADD CONSTRAINT "machine_keys_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "workspace_logs" ADD CONSTRAINT "workspace_logs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_state_history" ADD CONSTRAINT "workspace_state_history_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_template_id_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id");