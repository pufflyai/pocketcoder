import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { Hono } from "hono";
import { managedPrincipalId } from "../bootstrap/managed-principals/principal-file";
import { registerPrincipalPlan } from "./principal-plan-admin";

const createStore = createTestStoreFactory();
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("the local plan re-reads the principal file and changes nothing", async () => {
  const store = await createStore();
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-plan-admin-"));
  directories.push(directory);
  const file = join(directory, "principals.json");
  const token = join(directory, "backend.token");
  await writeFile(
    file,
    JSON.stringify({
      principals: [
        { name: "backend", scopes: ["workspaces:read"], templates: [], key: { target: { kind: "file", path: token } } },
      ],
    }),
  );
  const app = new Hono();
  registerPrincipalPlan(app, { store, pepper: "plan-pepper", file });
  const response = await app.request("/v1/principals/plan");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    principals: [{ id: managedPrincipalId("backend"), action: "create" }],
    keys: [{ name: "backend", action: "issue", reason: "missing", target: `file ${token}` }],
  });
  expect(await store.getPrincipal(managedPrincipalId("backend"))).toBeNull();
  expect(await Bun.file(token).exists()).toBe(false);
});
