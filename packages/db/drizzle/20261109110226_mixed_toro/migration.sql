ALTER TABLE "managed_sessions" ADD COLUMN "close" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD COLUMN "resume_requested_at" timestamp with time zone;