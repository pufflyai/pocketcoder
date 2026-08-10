import { createHash } from "node:crypto";

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertValidSchema(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(
      `invalid database schema name: ${JSON.stringify(schema)} (expected ${SCHEMA_NAME})`,
    );
  }
  return schema;
}

export function qualify(schema: string, table: string): string {
  return `"${assertValidSchema(schema)}"."${table}"`;
}

// The stable signed key serializes migration runs for one configured schema.
export function advisoryLockKey(schema: string): bigint {
  const digest = createHash("sha256").update(`pocketcoder:${schema}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}
