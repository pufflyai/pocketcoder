import { type PGlite, types } from "@electric-sql/pglite";
import type { Query, SQL } from "drizzle-orm";
import { PgDialect, type PgSelectConfig } from "drizzle-orm/pg-core";
import type { QueryContext } from "./context";
import { requiredRow } from "./required-row";

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

export function compileStaticSelect<Rows extends unknown[]>(
  client: PGlite,
  query: { execute(): Promise<Rows>; toSQL(): Omit<Query, "typings">; getSQL(): SQL; _: { config: PgSelectConfig } },
  joins: Record<string, boolean>,
) {
  query.toSQL();
  const fields = query._.config.fieldsFlat;
  if (!fields) throw new Error("select query has no compiled fields");
  const dialect = new PgDialect({ useJitMappers: true });
  const compiled = dialect.sqlToQuery(query.getSQL().inlineParams());
  const mapper = dialect.mapperGenerators.rows<Rows[number]>(fields, joins);
  // A fixed schema query needs one simple-protocol message and no parameter discovery.
  return async () => {
    const [result] = await client.exec(compiled.sql, {
      rowMode: "array",
      parsers: { [types.TIMESTAMPTZ]: (value) => value },
    });
    return mapper(requiredRow(result).rows as unknown as unknown[][]) as Rows;
  };
}
