// These tables have no fixed PostgreSQL schema because deployments may set
// POCKETCODER_DATABASE_SCHEMA. Drizzle migrations set search_path while store
// queries use fully qualified table names.
export * from "./access";
export * from "./activity";
export * from "./persistence";
export * from "./workspaces";
