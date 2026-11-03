import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesDriver } from "./kubernetes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// kubectl is the provider boundary: this script answers like an API server holding one Job and its events.
async function driverFor(jobStatus: Record<string, unknown>, eventReasons: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "pc-refused-"));
  directories.push(directory);
  const script = join(directory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(directory, "kubectl.cmd") : script;
  const job = { metadata: { name: "workspace", uid: "job-uid" }, status: jobStatus };
  const events = {
    items: eventReasons.map((reason) => ({
      reason,
      involvedObject: { kind: "Job", uid: "job-uid" },
      message: 'Error creating: pods "workspace-x" is forbidden: denied by policy',
    })),
  };
  await writeFile(
    script,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const start = args.findIndex((arg) => arg === "get");
const kind = args[start + 1];
const selector = args[args.indexOf("--field-selector") + 1] ?? "";
if (kind === "job") console.log(${JSON.stringify(JSON.stringify(job))});
if (kind === "events") {
  const events = ${JSON.stringify(events)};
  const wanted = Object.fromEntries(selector.split(",").map((pair) => pair.split("=")));
  const items = events.items.filter(
    (event) => event.involvedObject.uid === wanted["involvedObject.uid"] && event.reason === wanted.reason,
  );
  console.log(JSON.stringify({ items }));
}
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32")
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  return new KubernetesDriver({ namespace: "synthetic-only", kubectlBin: bin });
}

test.each([
  { name: "a Job whose Pod creation failed", status: {}, events: ["FailedCreate"], refused: true },
  { name: "a Job still waiting for its first Pod", status: {}, events: [], refused: false },
  { name: "a Job with a running Pod", status: { active: 1 }, events: ["FailedCreate"], refused: false },
  { name: "a finished Job", status: { failed: 1 }, events: ["FailedCreate"], refused: false },
])("inspect reports $name as refused: $refused", async ({ status, events, refused }) => {
  const driver = await driverFor(status, events);
  const state = await driver.inspect({ kind: "kubernetes", id: "workspace", jobUid: "job-uid" });
  expect(state.refused ?? false).toBe(refused);
});
