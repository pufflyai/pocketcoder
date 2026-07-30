import { createHash } from "node:crypto";

// The runtime schema is configurable: POCKETCODER_DATABASE_SCHEMA defaults to
// `pocketcoder` and may live in a dedicated database or an existing one. Every
// identifier is schema-qualified; nothing touches other schemas.

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertValidSchema(schema: string): string {
	if (!SCHEMA_RE.test(schema)) {
		throw new Error(
			`invalid database schema name: ${JSON.stringify(schema)} (expected ${SCHEMA_RE})`,
		);
	}
	return schema;
}

export function qualify(schema: string, table: string): string {
	return `"${assertValidSchema(schema)}"."${table}"`;
}

// Stable signed 64-bit advisory-lock key derived from the configured schema,
// so concurrent migrators on the same schema serialize while different
// schemas do not contend.
export function advisoryLockKey(schema: string): bigint {
	const digest = createHash("sha256").update(`pocketcoder:${schema}`).digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}
