import type { Query } from "drizzle-orm";
import { PgDialect, type PgSelectConfig } from "drizzle-orm/pg-core";
import type { QueryContext } from "./context";

export function compileSelect<Rows extends unknown[]>(
  query: { execute(): Promise<Rows>; toSQL(): Omit<Query, "typings">; _: { config: PgSelectConfig } },
  joins: Record<string, boolean>,
) {
  const compiled = query.toSQL();
  const fields = query._.config.fieldsFlat;
  if (!fields) throw new Error("select query has no compiled fields");
  // Generate direct field assignments once instead of walking each field path on every row.
  const mapper = new PgDialect({ useJitMappers: true }).mapperGenerators.rows<Rows[number]>(fields, joins);
  // Each execution binds the statement to its current database or transaction session.
  return (context: QueryContext, bindings: Record<string, unknown> = {}) =>
    context._.session.prepareQuery<{ execute: Rows }>(compiled, "arrays", false, mapper).execute(bindings);
}
