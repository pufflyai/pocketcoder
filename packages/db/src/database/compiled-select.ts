import { randomUUID } from "node:crypto";
import { type PGlite, parse, protocol, types } from "@electric-sql/pglite";
import { fillPlaceholders, type Query } from "drizzle-orm";
import { PgDialect, type PgSelectConfig } from "drizzle-orm/pg-core";
import { requiredRow } from "./required-row";

export function compileSelect<Rows extends unknown[]>(
  client: PGlite,
  query: { execute(): Promise<Rows>; toSQL(): Omit<Query, "typings">; _: { config: PgSelectConfig } },
  joins: Record<string, boolean>,
) {
  const compiled = query.toSQL();
  const fields = query._.config.fieldsFlat;
  if (!fields) throw new Error("select query has no compiled fields");
  // Generate direct field assignments once instead of walking each field path on every row.
  const mapper = new PgDialect({ useJitMappers: true }).mapperGenerators.rows<Rows[number]>(fields, joins);
  const name = `pocketcoder_${randomUUID()}`;
  const { serialize } = protocol;
  let parameterTypes: number[] | undefined;
  // PGlite has separate transaction and query locks. Both must exclude an open transaction.
  return (bindings: Record<string, unknown> = {}) =>
    client._runExclusiveTransaction(() =>
      client.runExclusive(async () => {
        // Prepare on the first admission, then reuse the plan without caching its bound values.
        if (!parameterTypes) {
          const result = await client.execProtocol(
            Buffer.concat([
              serialize.parse({ name, text: compiled.sql }),
              serialize.describe({ type: "S", name }),
              serialize.sync(),
            ]),
            { syncToFs: false },
          );
          parameterTypes = parse.parseDescribeStatementResults(result.messages);
        }
        const values = fillPlaceholders(compiled.params, bindings).map((value, index) => {
          if (value === null || value === undefined) return null;
          const serializer = client.serializers[requiredRow(requiredRow(parameterTypes)[index])];
          return serializer ? serializer(value) : String(value);
        });
        // These queries use one plan for all values. Avoid five custom plans before reuse starts.
        // The setting stays local to this batch; Sync allows COMMIT to settle errors as a rollback.
        const result = await client.execProtocol(
          Buffer.concat([
            serialize.query("BEGIN; SET LOCAL plan_cache_mode = force_generic_plan"),
            serialize.bind({ statement: name, values }),
            serialize.describe({ type: "P" }),
            serialize.execute(),
            serialize.sync(),
            serialize.query("COMMIT"),
          ]),
        );
        const rows = parse
          .parseResults(result.messages, client.parsers, {
            rowMode: "array",
            parsers: { [types.TIMESTAMP]: (value) => value, [types.TIMESTAMPTZ]: (value) => value },
          })
          .find((result) => result.command === "SELECT");
        return mapper(requiredRow(rows).rows as unknown as unknown[][]) as Rows;
      }),
    );
}
