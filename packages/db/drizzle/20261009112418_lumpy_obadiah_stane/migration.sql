CREATE TABLE "workspace_lease_fences" (
	"workspace_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_leases" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"secret_name" text NOT NULL,
	"secret_version_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"source_url" text NOT NULL,
	"source_revision" text NOT NULL,
	"template_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"request_expires_at" timestamp with time zone NOT NULL,
	"issuer_lease_id" text,
	"issuer_expires_at" timestamp with time zone,
	"credential_bytes" integer,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "workspace_leases_secret_name_request_id_unique" UNIQUE("secret_name","request_id"),
	CONSTRAINT "workspace_leases_purpose" CHECK ("purpose" IN ('setup-issuer')),
	CONSTRAINT "workspace_leases_state" CHECK ("state" IN ('requested', 'issued', 'delivered', 'revoking', 'revoked', 'expired')),
	CONSTRAINT "workspace_leases_request_expiry" CHECK ("request_expires_at" > "created_at" AND "request_expires_at" <= "created_at" + interval '5 minutes'),
	CONSTRAINT "workspace_leases_issuer_expiry" CHECK (("issuer_lease_id" IS NULL AND "issuer_expires_at" IS NULL) OR ("issuer_lease_id" IS NOT NULL AND "issuer_expires_at" IS NOT NULL AND "issuer_expires_at" > "created_at" AND "issuer_expires_at" <= "request_expires_at")),
	CONSTRAINT "workspace_leases_closed" CHECK (("state" IN ('revoked', 'expired')) = ("closed_at" IS NOT NULL)),
	CONSTRAINT "workspace_leases_credential_bytes" CHECK ("credential_bytes" IS NULL OR "credential_bytes" BETWEEN 1 AND 65536),
	CONSTRAINT "workspace_leases_acknowledged" CHECK ("state" NOT IN ('issued', 'delivered', 'expired') OR ("issuer_lease_id" IS NOT NULL AND "credential_bytes" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "workspace_leases_workspace" ON "workspace_leases" ("workspace_id","state");--> statement-breakpoint
ALTER TABLE "workspace_lease_fences" ADD CONSTRAINT "workspace_lease_fences_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_oK6JwRD2T7nB_fkey" FOREIGN KEY ("secret_version_id","secret_name","purpose") REFERENCES "secret_versions"("id","name","type");--> statement-breakpoint
ALTER TABLE "secret_versions" DROP CONSTRAINT "secret_versions_type_check", ADD CONSTRAINT "secret_versions_type_check" CHECK ("type" IN ('setup-issuer', 'registry'));