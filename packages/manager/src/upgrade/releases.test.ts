import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ReleaseManifestSchema, requireRollback, requireUpgrade } from "./releases";

const source = {
  version: "1.0.0-rc.1",
  controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
  data: { pglite: "0.5.8", postgres: "18.3", migrations: [{ name: "first", hash: "a".repeat(64) }] },
  agentProtocol: 11,
  upgradesFrom: [],
  rollbackTo: [],
  evidence: "https://example.test/real-proof",
};
const target = {
  ...source,
  version: "1.0.0-rc.2",
  controllerImage: `controller.test/server@sha256:${"b".repeat(64)}`,
  upgradesFrom: [source.version],
  rollbackTo: [source.version],
};

test("release admission requires exact engine, schema history and agent compatibility", () => {
  requireUpgrade(source, target);
  for (const changed of [
    { ...target, upgradesFrom: [] },
    { ...target, agentProtocol: 12 },
    { ...target, data: { ...target.data, pglite: "0.6.0" } },
    { ...target, data: { ...target.data, postgres: "19" } },
    { ...target, data: { ...target.data, migrations: [{ name: "first", hash: "b".repeat(64) }] } },
  ])
    expect(() => requireUpgrade(source, changed)).toThrow("upgrade_not_tested");
});

test("a tested image rollback is refused once the schema changes", () => {
  const upgrade = {
    source,
    target,
    requestedVersion: target.version,
    suspendId: randomUUID(),
    resumeId: randomUUID(),
    mode: "upgrade" as const,
  };
  requireRollback(upgrade);
  const migrated = {
    ...target,
    data: { ...target.data, migrations: [...target.data.migrations, { name: "second", hash: "b".repeat(64) }] },
  };
  requireUpgrade(source, migrated);
  expect(() => requireRollback({ ...upgrade, target: migrated })).toThrow("rollback_incompatible");
  expect(() => requireRollback({ ...upgrade, target: { ...target, rollbackTo: [] } })).toThrow("rollback_incompatible");
});

test("manifest versions and immutable image identities cannot be ambiguous", () => {
  expect(
    ReleaseManifestSchema.safeParse({ format: "pocketcoder-releases/v1", releases: [source, target] }).success,
  ).toBe(true);
  for (const changed of [
    source,
    { ...target, version: source.version },
    { ...target, controllerImage: source.controllerImage },
    { ...target, controllerImage: "controller.test/server:latest" },
  ])
    expect(
      ReleaseManifestSchema.safeParse({ format: "pocketcoder-releases/v1", releases: [source, changed] }).success,
    ).toBe(false);
});
