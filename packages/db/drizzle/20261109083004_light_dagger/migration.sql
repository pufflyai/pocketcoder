CREATE TABLE "model_gateway_grants" (
	"id" uuid PRIMARY KEY,
	"token_digest" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incarnation_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "close" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "resume_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_grant_token" ON "model_gateway_grants" ("token_digest");--> statement-breakpoint
ALTER TABLE "model_gateway_grants" ADD CONSTRAINT "model_gateway_grants_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");