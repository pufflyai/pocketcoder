import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createStructuredLogger, type LogRecord } from "../../observability/observability";
import { reconcileManagedPrincipals } from "./managed-principals";
import { managedPrincipalId, parsePrincipalFile } from "./principal-file";

const createStore = createTestStoreFactory();
const pepper = "managed-principals-pepper";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const store = await createStore();
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-managed-principals-"));
  directories.push(directory);
  const records: LogRecord[] = [];
  const logger = createStructuredLogger((record) => records.push(record));
  const declare = (names: string[]) =>
    parsePrincipalFile(
      JSON.stringify({
        principals: names.map((name) => ({
          name,
          scopes: ["workspaces:read"],
          templates: ["echo"],
          admission_template: `${name}-plan`,
          key: { target: { kind: "file", path: join(directory, `${name}.token`) } },
        })),
        admission_map: { kind: "file", path: join(directory, "admission-map.json") },
      }),
    );
  const reconcile = (names: string[], dryRun = false) =>
    reconcileManagedPrincipals({ store, pepper, file: declare(names), dryRun, logger });
  const token = (name: string) => readFile(join(directory, `${name}.token`), "utf8").catch(() => null);
  return { store, directory, records, reconcile, token };
}

test("a fresh controller creates declared principals and writes their keys and admission map", async () => {
  const f = await fixture();
  const result = await f.reconcile(["backend", "batch"]);
  expect(result.principals.map((change) => change.action)).toEqual(["create", "create"]);
  for (const name of ["backend", "batch"]) {
    const id = managedPrincipalId(name);
    expect(await f.store.getPrincipal(id)).toMatchObject({ name, scopes: ["workspaces:read"], disabledAt: null });
    expect(await f.token(name)).toStartWith("pkt_");
  }
  const map = JSON.parse(await readFile(join(f.directory, "admission-map.json"), "utf8"));
  expect(map.principals).toContainEqual({
    id: managedPrincipalId("backend"),
    name: "backend",
    admission_template: "backend-plan",
  });
  const logs = JSON.stringify(f.records);
  expect(logs).toContain("backend");
  expect(logs).not.toContain("pkt_");
});

test("restarting with the same file changes nothing", async () => {
  const f = await fixture();
  await f.reconcile(["backend"]);
  const token = await f.token("backend");
  const keys = await f.store.listMachineKeys(managedPrincipalId("backend"), { limit: 10 });
  f.records.length = 0;
  const again = await f.reconcile(["backend"]);
  expect(again.principals.map((change) => change.action)).toEqual(["unchanged"]);
  expect(again.keys.map((change) => change.action)).toEqual(["keep"]);
  expect(again.admissionMap).toBe("unchanged");
  expect(await f.token("backend")).toBe(token);
  expect(await f.store.listMachineKeys(managedPrincipalId("backend"), { limit: 10 })).toEqual(keys);
  expect(f.records).toEqual([]);
});

test("dry run reports planned changes without writing anything", async () => {
  const f = await fixture();
  const planned = await f.reconcile(["backend"], true);
  expect(planned.principals).toMatchObject([{ name: "backend", action: "create" }]);
  expect(planned.keys).toMatchObject([{ name: "backend", action: "issue", reason: "missing" }]);
  expect(planned.admissionMap).toBe("write");
  expect(await f.store.getPrincipal(managedPrincipalId("backend"))).toBeNull();
  expect(await f.token("backend")).toBeNull();
  expect(f.records.every((record) => record.dry_run === true)).toBe(true);
});

test("removing a managed principal disables it and revokes its keys", async () => {
  const f = await fixture();
  await f.reconcile(["backend", "batch"]);
  const hand = await f.store.createPrincipal("hand-made", ["workspaces:read"], []);
  const result = await f.reconcile(["backend"]);
  expect(result.principals).toContainEqual(expect.objectContaining({ name: "batch", action: "disable" }));
  const batch = await f.store.getPrincipal(managedPrincipalId("batch"));
  expect(batch?.disabledAt).toBeInstanceOf(Date);
  const keys = await f.store.listMachineKeys(managedPrincipalId("batch"), { limit: 10 });
  expect(keys.every((key) => key.revokedAt)).toBe(true);
  expect((await f.store.getPrincipal(hand.id))?.disabledAt).toBeNull();
});

test("a declared name held by an unmanaged principal stops reconciliation before any change", async () => {
  const f = await fixture();
  await f.store.createPrincipal("backend", ["workspaces:read"], []);
  await expect(f.reconcile(["batch", "backend"])).rejects.toThrow("backend");
  expect(await f.store.getPrincipal(managedPrincipalId("batch"))).toBeNull();
});

test("a dry run reports a name held by an unmanaged principal as a conflict", async () => {
  const f = await fixture();
  await f.store.createPrincipal("backend", ["workspaces:read"], []);
  const planned = await f.reconcile(["backend"], true);
  expect(planned.principals).toMatchObject([{ name: "backend", action: "conflict" }]);
});
