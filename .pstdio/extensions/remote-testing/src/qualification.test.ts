import { expect, test } from "bun:test";
import { qualificationStatus, requiredTargets } from "./qualification";

test("reads the candidate-owned discovery result and rejects missing targets", () => {
  expect(requiredTargets('REMOTE_TEST_TARGETS ["linux-x64","win32-arm64"]')).toEqual(["linux-x64", "win32-arm64"]);
  expect(() => requiredTargets("log without target discovery")).toThrow("did not return targets");
  expect(() => requiredTargets("REMOTE_TEST_TARGETS []")).toThrow("Invalid candidate targets");
});
test("never reports missing, canceled or unrun targets as passed", () => {
  const targets = ["linux-x64", "linux-arm64", "win32-x64"];
  expect(qualificationStatus(targets, { "linux-x64": "passed", "linux-arm64": "passed" })).toBe("incomplete");
  expect(qualificationStatus(targets, { "linux-x64": "failed" })).toBe("failed");
  expect(
    qualificationStatus(targets, { "linux-x64": "passed", "linux-arm64": "passed", "win32-x64": "canceled" }),
  ).toBe("incomplete");
  expect(qualificationStatus(targets, Object.fromEntries(targets.map((t) => [t, "passed"])))).toBe("passed");
});

test("candidate discovery includes computed host declarations", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DISCOVERY_COMMAND } = await import("./target-discovery");
  const root = await mkdtemp(join(tmpdir(), "target-discovery-"));
  try {
    await Bun.write(
      join(root, "scripts/ci/production-platforms.ts"),
      'const windows="win32-arm64"; export const productionDesktopPlatforms=()=>[{target:"linux-x64",os:"ubuntu-24.04"},{target:windows,os:"windows-11-arm"}]; export const productionToolchainPlatforms=()=>[]; export const productionPerformanceWorkloads=()=>[{os:"ubuntu-24.04"}];',
    );
    const child = Bun.spawn(["sh", "-c", DISCOVERY_COMMAND], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(requiredTargets(stdout)).toEqual(["linux-x64", "win32-arm64"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
