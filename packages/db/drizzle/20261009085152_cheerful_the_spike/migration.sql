CREATE TABLE "secret_versions" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"nonce" bytea NOT NULL UNIQUE,
	"ciphertext" bytea NOT NULL,
	"tag" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_versions_id_name_type_unique" UNIQUE("id","name","type"),
	CONSTRAINT "secret_versions_type_check" CHECK ("type" IN ('registry')),
	CONSTRAINT "secret_versions_nonce_length" CHECK (octet_length("nonce") = 12),
	CONSTRAINT "secret_versions_tag_length" CHECK (octet_length("tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"name" text PRIMARY KEY,
	"type" text NOT NULL,
	"version_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_version_id_name_type_secret_versions_id_name_type_fkey" FOREIGN KEY ("version_id","name","type") REFERENCES "secret_versions"("id","name","type");