CREATE TABLE "usage_samples" (
	"account_id" uuid,
	"bucket_at" timestamp with time zone,
	"sampled_at" timestamp with time zone NOT NULL,
	"workspaces" integer,
	"warm" integer,
	"volume_bytes" bigint,
	CONSTRAINT "usage_samples_pkey" PRIMARY KEY("account_id","bucket_at"),
	CONSTRAINT "usage_nonnegative" CHECK ("workspaces" >= 0 and "warm" >= 0 and "volume_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "usage_retention" ON "usage_samples" ("sampled_at");--> statement-breakpoint
ALTER TABLE "usage_samples" ADD CONSTRAINT "usage_samples_account_id_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id");