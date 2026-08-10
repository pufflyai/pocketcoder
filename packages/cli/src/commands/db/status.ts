import { getMigrationStatus, type MigrationStatus } from "@pstdio/pocketcoder-db";
import { SQL } from "bun";
import type { Argv } from "yargs";
import { dbConfig } from "../../cli-context";
import { addAction, unchanged } from "../command";

export function formatMigrationStatus(
  migrations: readonly Pick<MigrationStatus, "name" | "appliedAt" | "drifted">[],
): string[] {
  return migrations.map((migration) => {
    const state = migration.drifted
      ? "DRIFTED"
      : migration.appliedAt
        ? `applied ${migration.appliedAt.toISOString()}`
        : "pending";
    return `${migration.name}\t${state}`;
  });
}

export function addStatusCommand(parser: Argv) {
  return addAction(parser, "status", "Show migration status", unchanged, async () => {
    const { url, schema } = dbConfig();
    const sql = new SQL(url);
    try {
      for (const line of formatMigrationStatus(await getMigrationStatus(sql, schema))) {
        console.log(line);
      }
    } finally {
      await sql.end();
    }
  });
}
