CREATE TABLE "managed_issuers" (
	"principal_id" uuid,
	"name" text,
	"config" jsonb NOT NULL,
	CONSTRAINT "managed_issuers_pkey" PRIMARY KEY("principal_id","name")
);
--> statement-breakpoint
ALTER TABLE "budget_policies" DROP CONSTRAINT "budget_policies_scope_id_managed_scopes_scope_id_fkey";--> statement-breakpoint
ALTER TABLE "managed_scope_grants" DROP CONSTRAINT "managed_scope_grants_scope_id_managed_scopes_scope_id_fkey";--> statement-breakpoint
DROP TABLE "budget_policies";--> statement-breakpoint
DROP TABLE "managed_credentials";--> statement-breakpoint
DROP TABLE "managed_scope_grants";--> statement-breakpoint
DROP TABLE "managed_scopes";--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP CONSTRAINT "workspace_leases_issuer_expiry";--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP CONSTRAINT "workspace_leases_acknowledged";--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "template_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "template_version" text;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "placement" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "workspaces_per_owner" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "sessions_per_workspace" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "dispatch_deadline_seconds" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD COLUMN "updated_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "cancel" jsonb;--> statement-breakpoint
ALTER TABLE "managed_profiles" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "managed_profiles" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "managed_profiles" DROP COLUMN "profile";--> statement-breakpoint
ALTER TABLE "managed_profiles" DROP COLUMN "business_slots";--> statement-breakpoint
ALTER TABLE "managed_profiles" ADD PRIMARY KEY ("principal_id","name");--> statement-breakpoint
ALTER TABLE "managed_issuers" ADD CONSTRAINT "managed_issuers_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP CONSTRAINT "workspace_leases_state", ADD CONSTRAINT "workspace_leases_state" CHECK ("state" IN ('requested', 'issued', 'delivered', 'revoking', 'revoked', 'expired', 'superseded'));
--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP CONSTRAINT "workspace_leases_oK6JwRD2T7nB_fkey";--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD COLUMN "revoke_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP COLUMN "issuer_lease_id";--> statement-breakpoint
ALTER TABLE "workspace_leases" ALTER COLUMN "secret_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_issuer_expiry" CHECK ("issuer_expires_at" IS NULL OR ("issuer_expires_at" > "created_at" AND "issuer_expires_at" <= "request_expires_at"));--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_acknowledged" CHECK ("state" NOT IN ('issued', 'delivered') OR ("issuer_expires_at" IS NOT NULL AND "credential_bytes" IS NOT NULL));