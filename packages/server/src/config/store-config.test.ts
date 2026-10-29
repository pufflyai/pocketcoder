import { describe, expect, test } from "bun:test";
import { storeConfig } from "./store-config";

const postgres = {
  POCKETCODER_DATABASE_URL: "postgres://pc:secret@db.internal:5432/pocketcoder",
  POCKETCODER_AUTH_PEPPER: "pepper",
  POCKETCODER_JOURNAL_DIR: "/var/lib/pocketcoder-journal",
};

describe("store selection", () => {
  test("a database URL selects PostgreSQL without POCKETCODER_STORE", () => {
    expect(storeConfig(postgres)).toEqual({
      kind: "postgres",
      databaseUrl: postgres.POCKETCODER_DATABASE_URL,
      databaseSchema: "pocketcoder",
    });
  });

  test("POCKETCODER_STORE=pglite keeps the embedded store even with a URL", () => {
    expect(storeConfig({ ...postgres, POCKETCODER_STORE: "pglite" })).toEqual({ kind: "pglite" });
  });

  test("no URL keeps the embedded store for local and desktop use", () => {
    expect(storeConfig({})).toEqual({ kind: "pglite" });
  });

  test("PostgreSQL needs a URL, the existing pepper and a deletion journal", () => {
    expect(() => storeConfig({ POCKETCODER_STORE: "postgres" })).toThrow("POCKETCODER_DATABASE_URL is required");
    expect(() => storeConfig({ ...postgres, POCKETCODER_AUTH_PEPPER: undefined })).toThrow(
      "POCKETCODER_AUTH_PEPPER is required",
    );
    expect(() => storeConfig({ ...postgres, POCKETCODER_JOURNAL_DIR: undefined })).toThrow(
      "POCKETCODER_JOURNAL_DIR is required",
    );
  });

  test("PostgreSQL refuses data-folder features", () => {
    expect(() => storeConfig({ ...postgres, POCKETCODER_OFF_NODE_CONFIG: "/etc/off-node.json" })).toThrow(
      "Off-node backup is not available with PostgreSQL",
    );
  });

  test("accepts a schema and rejects unsafe names", () => {
    expect(storeConfig({ ...postgres, POCKETCODER_DATABASE_SCHEMA: "pc_alpha" })).toMatchObject({
      databaseSchema: "pc_alpha",
    });
    expect(() => storeConfig({ ...postgres, POCKETCODER_DATABASE_SCHEMA: 'x"; drop' })).toThrow(
      "invalid database schema name",
    );
  });

  test("rejects unknown store kinds", () => {
    expect(() => storeConfig({ POCKETCODER_STORE: "memory" })).toThrow("POCKETCODER_STORE must be one of");
  });
});
