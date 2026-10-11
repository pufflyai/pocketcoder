ALTER TABLE "operations" DROP CONSTRAINT "operations_account_id_key";--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "kind" text DEFAULT 'provision' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "request_id" text DEFAULT 'provision' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "phase" text DEFAULT 'controller' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operation_identity" UNIQUE("account_id","request_id");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operation_kind" CHECK ("kind" in ('provision','suspend','resume'));--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operation_phase" CHECK ("phase" in ('controller','scale','complete'));--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "account_state", ADD CONSTRAINT "account_state" CHECK ("state" in ('provisioning','ready','suspending','suspended','resuming'));