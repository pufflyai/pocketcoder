import type { MigrationRegistry } from "./migrator";
import { RELEASE_081_MIGRATION } from "./release-081";

interface AppliedMigration {
  name: string;
  hash: string;
}

// A 0.8.1 database applied RELEASE_081_MIGRATION after the eight migrations it shares with 1.0.
// The plan drops that history row, runs only the statements of its 1.0 replacement that are
// still missing, and records the replacement with its real hash. The prefix check stays strict.
export function planUpgrade<Row extends AppliedMigration>(applied: Row[], registry: MigrationRegistry) {
  const index = applied.findIndex((row) => row.name === RELEASE_081_MIGRATION.name);
  if (index === -1) return { applied, registry, release081: false };
  if (applied[index]?.hash !== RELEASE_081_MIGRATION.hash)
    throw new Error(`migration ${RELEASE_081_MIGRATION.name} has checksum drift`);
  if (index !== applied.length - 1)
    throw new Error(`unknown or out-of-order migration after ${RELEASE_081_MIGRATION.name}`);
  const shipped = new Set<string>(RELEASE_081_MIGRATION.sql);
  return {
    applied: applied.slice(0, index),
    registry: registry.map((migration) =>
      migration.name === RELEASE_081_MIGRATION.replacedBy
        ? { ...migration, sql: migration.sql.filter((statement) => !shipped.has(statement)) }
        : migration,
    ),
    release081: true,
  };
}
