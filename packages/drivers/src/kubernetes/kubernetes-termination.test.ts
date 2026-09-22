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
const args = process.argv.slice(2);
const start = args.findIndex((arg) => ["get", "patch", "delete"].includes(arg));
if (args.slice(start, start + 2).join(" ") === ${JSON.stringify(failure)}) process.exit(1);
if (args.includes("get") && ${JSON.stringify(failure)} !== "absent") console.log(JSON.stringify({status:{active:1}}));
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
    const ref = { kind: "kubernetes", id: "synthetic-workspace" };
    const result = operation === "stop" ? driver.stop(ref, 1) : driver[operation](ref);
    await expect(result).rejects.toThrow("kubectl");
  });
}

test("confirmed absence remains idempotent for repeated stop and remove", async () => {
  const driver = await driverWithResponse("absent");
  const ref = { kind: "kubernetes", id: "already-removed" };
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
