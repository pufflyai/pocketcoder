import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.skipIf(process.env.PC94_VOLUME_TEST !== "1")(
  "purges retained Kind bytes, refuses replacement and late claims, and preserves another account",
  async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const child = Bun.spawn(["bun", "examples/e2e/kind-purge-storage.ts", "--conformance"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      console.log(stdout);
      console.error(stderr);
      expect(code).toBe(0);
      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      expect(result).toMatchObject({
        retainedBytesRemoved: true,
        otherAccountBytesPresent: true,
        lateClaimRefused: true,
        replacementClaimRefused: true,
        retainedHandleRefused: true,
        replacementNamespaceRefused: true,
        absentNamespaceRetryVerified: true,
        duplicateStorageRefused: true,
        currentComputeRefused: true,
        retryVerified: true,
        cleanup: true,
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  },
  250_000,
);
