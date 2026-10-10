CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"namespace" text NOT NULL UNIQUE,
	"request_id" text NOT NULL UNIQUE,
	"request_digest" text NOT NULL,
	"plan" jsonb NOT NULL,
	"state" text NOT NULL,
	"bootstrap_request_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_state" CHECK ("state" in ('provisioning','ready'))
);
--> statement-breakpoint
CREATE TABLE "bootstrap_requests" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"replaces_request_id" uuid,
	"state" text NOT NULL,
	"key_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bootstrap_identity" UNIQUE("account_id","request_id"),
	CONSTRAINT "bootstrap_state" CHECK ("state" in ('pending','completed')),
	CONSTRAINT "bootstrap_expiry" CHECK (isfinite("expires_at") and "expires_at" > "created_at" and "expires_at" <= "created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL UNIQUE,
	"state" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operation_state" CHECK ("state" in ('pending','running','succeeded'))
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY,
	"digest" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_expiry" CHECK (isfinite("expires_at") and "expires_at" > "created_at" and "expires_at" <= "created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "bootstrap_requests" ADD CONSTRAINT "bootstrap_requests_account_id_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_account_id_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id");