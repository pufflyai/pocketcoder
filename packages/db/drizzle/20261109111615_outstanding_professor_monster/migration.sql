ALTER TABLE "budget_audits" DROP CONSTRAINT "budget_audits_j7QHV8Ue4LZo_fkey";--> statement-breakpoint
ALTER TABLE "budget_reports" DROP CONSTRAINT "budget_reports_nlISV9kK3JCn_fkey";--> statement-breakpoint
DROP TABLE "budget_audits";--> statement-breakpoint
DROP TABLE "budget_invocations";--> statement-breakpoint
DROP TABLE "budget_reports";--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "close" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "resume_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "managed_scopes" DROP COLUMN "blocked_reason";