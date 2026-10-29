ALTER TABLE "workspace_leases" ALTER COLUMN "source_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_leases" ALTER COLUMN "source_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_versions" DROP CONSTRAINT "secret_versions_type_check", ADD CONSTRAINT "secret_versions_type_check" CHECK ("type" IN ('setup-issuer', 'runtime-issuer', 'registry'));--> statement-breakpoint
ALTER TABLE "workspace_leases" DROP CONSTRAINT "workspace_leases_purpose", ADD CONSTRAINT "workspace_leases_purpose" CHECK ("purpose" IN ('setup-issuer', 'runtime-issuer'));