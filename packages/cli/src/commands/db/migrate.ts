import { migrateDatabase } from "@pstdio/pocketcoder-db";
import { SQL } from "bun";
import type { Argv } from "yargs";
import { dbConfig } from "../../cli-context";
import { addAction, unchanged } from "../command";

export function addMigrateCommand(parser: Argv) {
  return addAction(
    parser,
    "migrate",
    "Apply pending migrations to the configured schema",
    unchanged,
    async () => {
      const { url, schema } = dbConfig();
      const sql = new SQL(url);
      try {
        const applied = await migrateDatabase(sql, schema);
        console.log(
          applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date",
        );
      } finally {
        await sql.end();
      }
    },
  );
}
