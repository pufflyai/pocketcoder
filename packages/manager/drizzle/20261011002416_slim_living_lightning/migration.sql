CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"volume_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "volume_name" text DEFAULT 'controller-data' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "backup_id" uuid;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "compute_proof" jsonb;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_id_operations_id_fkey" FOREIGN KEY ("id") REFERENCES "operations"("id");--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_account_id_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id");--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "account_state", ADD CONSTRAINT "account_state" CHECK ("state" in ('provisioning','ready','suspending','suspended','resuming','restoring'));--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operation_kind", ADD CONSTRAINT "operation_kind" CHECK ("kind" in ('provision','suspend','resume','backup','restore'));--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operation_phase", ADD CONSTRAINT "operation_phase" CHECK ("phase" in ('controller','scale','complete','capture','fence','restore','recover','open'));