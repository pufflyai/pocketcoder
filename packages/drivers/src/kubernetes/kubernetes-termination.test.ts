import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesDriver } from "./kubernetes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function driverWithResponse(failure: string) {
  const directory = await mkdtemp(join(tmpdir(), "pc-termination-"));
  directories.push(directory);
  const script = join(directory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(directory, "kubectl.cmd") : script;
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const start = args.findIndex((arg) => ["get", "patch", "delete"].includes(arg));
const operation = args.slice(start, start + 2).join(" ");
const raw = args[args.indexOf("--raw") + 1] ?? "";
const failure = ${JSON.stringify(failure)};
if (operation === failure || (args.includes("--raw") && raw.includes(failure.replace("delete ", "/") + "s/"))) process.exit(1);
if (operation === "get job" && failure !== "absent" && !existsSync(${JSON.stringify(join(directory, "deleted"))})) console.log(JSON.stringify({metadata:{uid:"job-uid"},status:{active:1}}));
if (operation === "get pods") console.log(JSON.stringify({items:failure === "delete pod" ? [{metadata:{name:"pod",uid:"pod-uid",ownerReferences:[{kind:"Job",controller:true,uid:"job-uid"}]}}] : []}));
if (args.includes("--raw") && raw.includes("/jobs/")) writeFileSync(${JSON.stringify(join(directory, "deleted"))}, "deleted");
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32")
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  return new KubernetesDriver({ namespace: "synthetic-only", kubectlBin: bin });
}

for (const [operation, failure] of [
  ["inspect", "get job"],
  ["stop", "get job"],
  ["stop", "patch job"],
  ["stop", "delete pod"],
  ["remove", "delete job"],
  ["remove", "delete secret"],
] as const) {
  test(`${operation} propagates ${failure} failure instead of reporting termination`, async () => {
    const driver = await driverWithResponse(failure);
    const ref = { kind: "kubernetes", id: "synthetic-workspace", jobUid: "job-uid" };
    const result = operation === "stop" ? driver.stop(ref, 1) : driver[operation](ref);
    await expect(result).rejects.toThrow("kubectl");
  });
}

test("confirmed absence remains idempotent for repeated stop and remove", async () => {
  const driver = await driverWithResponse("absent");
  const ref = { kind: "kubernetes", id: "already-removed", jobUid: "job-uid" };
  expect(await driver.inspect(ref)).toEqual({ exists: false, running: false, exitCode: null });
  await driver.stop(ref, 1);
  await driver.remove(ref);
  await driver.stop(ref, 1);
  await driver.remove(ref);
});

test("purge propagates input Secret deletion failures", async () => {
  const driver = await driverWithResponse("delete secret");
  await expect(driver.purgeInput(crypto.randomUUID())).rejects.toThrow("kubectl");
});
