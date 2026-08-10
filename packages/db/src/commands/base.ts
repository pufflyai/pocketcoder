import { randomUUID } from "node:crypto";
import type { ReasonCode, WorkspaceState } from "@pstdio/pocketcoder-contracts";
import { buildEventEnvelope, type WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import { assertValidSchema } from "../database-schema";
import { getMigrationStatus } from "../migrations/migrator";

// PostgreSQL implementation of the Store contract. All identifiers are
// qualified with the configured schema; the runtime never reads or writes
// another schema.

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
export const MAX_CONVERSATION_MESSAGES = 100_000;
export const CLAIM_LEASE_MS = 60_000;

export type Row = Record<string, unknown>;

export function pgTextArray(items: readonly string[]): string {
  return `{${items.map((i) => `"${i.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

export function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    const inner = value.replace(/^\{|\}$/g, "");
    if (inner === "") return [];
    return inner.split(",").map((s) => s.replace(/^"|"$/g, "").replaceAll('\\"', '"'));
  }
  return [];
}

export function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function asDateOrNull(value: unknown): Date | null {
  return value == null ? null : asDate(value);
}

export function asBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  }
  return null;
}

export function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export function asJsonOr<T>(value: unknown, fallback: T): T {
  return value == null ? fallback : asJson<T>(value);
}

export function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

export function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value === "string" && values.includes(value)) return value as Values[number];
  throw new Error(`database row has invalid ${field}`);
}

export function nullableEnumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] | null {
  return value == null ? null : enumValue(value, values, field);
}

export class DatabaseCommands {
  protected readonly sql: SQL;
  protected readonly schema: string;
  protected changeWaiters = new Map<string, Set<() => void>>();
  protected coordinatorRelease: (() => Promise<void>) | null = null;

  constructor(databaseUrl: string, schema = "pocketcoder") {
    this.schema = assertValidSchema(schema);
    this.sql = new SQL(databaseUrl);
  }

  protected t(table: string): string {
    return `"${this.schema}"."${table}"`;
  }

  async init(): Promise<void> {
    const status = await getMigrationStatus(this.sql, this.schema);
    const drifted = status.filter((migration) => migration.drifted);
    if (drifted.length > 0) {
      throw new Error(
        `database schema ${this.schema} has migration checksum drift: ${drifted
          .map((migration) => migration.name)
          .join(", ")}`,
      );
    }
    const pending = status.filter((migration) => migration.appliedAt === null);
    if (pending.length > 0) {
      throw new Error(
        `database schema ${this.schema} has pending migrations: ${pending
          .map((migration) => migration.name)
          .join(", ")}; run pcd db migrate`,
      );
    }
  }

  async acquireCoordinatorLease(): Promise<() => Promise<void>> {
    if (this.coordinatorRelease) throw new Error("a PocketCoder coordinator is already active");
    const connection = await this.sql.reserve();
    const lockName = `${this.schema}:coordinator`;
    const rows = (await connection.unsafe(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 7351)) AS acquired",
      [lockName],
    )) as Row[];
    if (!asBoolean(rows[0]?.acquired)) {
      connection.release();
      throw new Error(`a PocketCoder coordinator is already active for schema ${this.schema}`);
    }
    const release = async () => {
      if (this.coordinatorRelease !== release) return;
      await connection.unsafe("SELECT pg_advisory_unlock(hashtextextended($1, 7351))", [lockName]);
      connection.release();
      this.coordinatorRelease = null;
    };
    this.coordinatorRelease = release;
    return release;
  }

  async close(): Promise<void> {
    await this.coordinatorRelease?.();
    for (const waiters of this.changeWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.changeWaiters.clear();
    await this.sql.end();
  }

  protected notifyWorkspaceChange(id: string): void {
    const waiters = this.changeWaiters.get(id);
    if (!waiters) return;
    this.changeWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }

  protected async appendHistoryTx(
    tx: SQL,
    row: WorkspaceRow,
    from: WorkspaceState | null,
    to: WorkspaceState,
    reason: ReasonCode | null,
    at: Date,
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO ${this.t("workspace_state_history")}
        (id, workspace_id, from_state, to_state, reason_code, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), row.id, from, to, reason, at],
    );
  }

  protected async appendEventTx(tx: SQL, row: WorkspaceRow, at: Date): Promise<void> {
    const payload = buildEventEnvelope(row, at);
    await tx.unsafe(
      `INSERT INTO ${this.t("event_outbox")}
        (id, workspace_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      [payload.id, row.id, payload.type, JSON.stringify(payload), at],
    );
  }
}
