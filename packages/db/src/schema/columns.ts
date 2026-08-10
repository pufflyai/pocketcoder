import { sql } from "drizzle-orm";
import { timestamp } from "drizzle-orm/pg-core";

export function sqlValues(values: readonly string[]) {
  return sql.raw(`(${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ")})`);
}

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
