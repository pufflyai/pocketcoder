CREATE TABLE "manager_installation" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"journal_id" uuid NOT NULL,
	CONSTRAINT "manager_single_installation" CHECK ("id" = 1)
);
