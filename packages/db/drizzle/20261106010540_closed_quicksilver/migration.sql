CREATE TABLE "budget_audits" (
	"id" uuid PRIMARY KEY,
	"invocation_id" uuid NOT NULL,
	"actor_key_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"previous" jsonb NOT NULL,
	"next" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_invocations" (
	"invocation_id" uuid PRIMARY KEY,
	"record" jsonb NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"scope_id" uuid,
	"revision" integer,
	"policy" jsonb NOT NULL,
	CONSTRAINT "budget_policies_pkey" PRIMARY KEY("scope_id","revision")
);
--> statement-breakpoint
CREATE TABLE "budget_reports" (
	"invocation_id" uuid,
	"digest" text,
	"evidence" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "budget_reports_pkey" PRIMARY KEY("invocation_id","digest")
);
--> statement-breakpoint
CREATE TABLE "export_objects" (
	"id" uuid PRIMARY KEY,
	"export_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"execution" jsonb NOT NULL,
	"reference" jsonb NOT NULL,
	"data" bytea,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "managed_credentials" (
	"binding_id" uuid PRIMARY KEY,
	"binding" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_observations" (
	"principal_id" uuid,
	"session_id" uuid,
	"sequence" bigint,
	"event" jsonb NOT NULL,
	CONSTRAINT "managed_observations_pkey" PRIMARY KEY("principal_id","session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "managed_profiles" (
	"profile_id" uuid,
	"revision" integer,
	"principal_id" uuid NOT NULL,
	"profile" jsonb NOT NULL,
	"business_slots" jsonb NOT NULL,
	CONSTRAINT "managed_profiles_pkey" PRIMARY KEY("profile_id","revision")
);
--> statement-breakpoint
CREATE TABLE "managed_scope_grants" (
	"scope_id" uuid,
	"principal_id" uuid,
	CONSTRAINT "managed_scope_grants_pkey" PRIMARY KEY("scope_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "managed_scopes" (
	"scope_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"installation" boolean NOT NULL,
	"blocked_reason" text,
	"last_clock_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_sessions" (
	"principal_id" uuid,
	"session_id" uuid,
	"conversation_id" uuid NOT NULL,
	"session" jsonb NOT NULL,
	"binding" jsonb,
	"binding_revision" integer DEFAULT 0 NOT NULL,
	"last_generation" integer DEFAULT 0 NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"queue_count" integer DEFAULT 0 NOT NULL,
	"queue_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "managed_sessions_pkey" PRIMARY KEY("principal_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "preview_grants" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"incarnation_id" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"access_revision" text NOT NULL,
	"previews" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ceiling_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD COLUMN "managed_authority" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lifetime" jsonb;--> statement-breakpoint
CREATE INDEX "export_objects_retention" ON "export_objects" ("expires_at");--> statement-breakpoint
CREATE INDEX "export_objects_workspace" ON "export_objects" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_installation_scope" ON "managed_scopes" ("installation") WHERE "installation" = true;--> statement-breakpoint
ALTER TABLE "budget_audits" ADD CONSTRAINT "budget_audits_j7QHV8Ue4LZo_fkey" FOREIGN KEY ("invocation_id") REFERENCES "budget_invocations"("invocation_id");--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_scope_id_managed_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "managed_scopes"("scope_id");--> statement-breakpoint
ALTER TABLE "budget_reports" ADD CONSTRAINT "budget_reports_nlISV9kK3JCn_fkey" FOREIGN KEY ("invocation_id") REFERENCES "budget_invocations"("invocation_id");--> statement-breakpoint
ALTER TABLE "managed_observations" ADD CONSTRAINT "managed_observations_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD CONSTRAINT "managed_profiles_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "managed_scope_grants" ADD CONSTRAINT "managed_scope_grants_scope_id_managed_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "managed_scopes"("scope_id");--> statement-breakpoint
ALTER TABLE "managed_scope_grants" ADD CONSTRAINT "managed_scope_grants_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "managed_scopes" ADD CONSTRAINT "managed_scopes_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD CONSTRAINT "managed_sessions_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "storage_reservations" DROP CONSTRAINT "storage_reservations_purpose_check", ADD CONSTRAINT "storage_reservations_purpose_check" CHECK ("purpose" IN ('checkpoint-upload', 'checkpoint-index', 'backup', 'attachment', 'screenshot', 'export'));