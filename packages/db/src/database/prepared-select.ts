import { randomUUID } from "node:crypto";
import type { Query } from "drizzle-orm";
import type { PgSelectConfig } from "drizzle-orm/pg-core";
import { compileSelect } from "./compiled-select";
import type { DatabaseContext } from "./context";

type PreparableSelect<Rows extends unknown[]> = {
  execute(): Promise<Rows>;
  toSQL(): Omit<Query, "typings">;
  prepare(name: string): { execute(placeholders?: Record<string, unknown>): Promise<Rows> };
  _: { config: PgSelectConfig };
};

// Hot admission queries reuse one plan. PGlite needs its own protocol path to keep the
// plan outside other transactions; PostgreSQL connections run the drizzle prepared query.
export function prepareSelect<Rows extends unknown[]>(
  context: DatabaseContext,
  query: PreparableSelect<Rows>,
  joins: Record<string, boolean>,
) {
  if (context.driver === "pglite") return compileSelect(context.client, query, joins);
  const prepared = query.prepare(`pocketcoder_${randomUUID().replaceAll("-", "")}`);
  return (bindings: Record<string, unknown> = {}) => prepared.execute(bindings);
}
