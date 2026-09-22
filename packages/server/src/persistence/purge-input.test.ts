import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { failedAllocation } from "./purge-support.test";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const app = await failedAllocation();
  const inputDir = await mkdtemp(join(tmpdir(), "pc-purge-input-"));
  roots.push(inputDir);
  const docker = new DockerDriver({ inputDir });
  // Exercise real provider-file cleanup with the existing in-memory runtime.
  Object.assign(app.driver, { purgeInput: (id: string) => docker.purgeInput(id) });
  await app.store.updateWorkspace(app.workspace.id, { providerRef: null }, new Date());
  const input = join(inputDir, `${app.workspace.id}.json`);
  const egress = join(inputDir, `${app.workspace.id}-egress.json`);
  await writeFile(input, "synthetic launch input left before provider reference commit");
  await writeFile(egress, "synthetic egress input");
  return { ...app, input, egress };
}

test("purge removes provider input artifacts even without a recorded provider", async () => {
  const app = await fixture();
  const operation = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "succeeded" });
  expect(await Bun.file(app.input).exists()).toBe(false);
  expect(await Bun.file(app.egress).exists()).toBe(false);
});

test("provider input cleanup failure keeps purge pending and retries", async () => {
  const app = await fixture();
  await rm(app.input);
  await mkdir(app.input);
  const operation = (await (await app.purge()).json()) as { id: string };
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "pending", completedAt: null });
  await rm(app.input, { recursive: true });
  await app.persistence.retryPurges();
  expect(await app.store.getOperation(operation.id)).toMatchObject({ state: "succeeded" });
  expect(await Bun.file(app.egress).exists()).toBe(false);
});
