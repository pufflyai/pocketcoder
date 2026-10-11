import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.skipIf(process.env.PC94_RBAC_TEST !== "1")(
  "removes exact retained account RBAC and refuses replacements or late grants while preserving another account",
  async () => {
    const child = Bun.spawn(["bun", "examples/e2e/kind-purge-rbac.ts", "--conformance"], {
      cwd: resolve(import.meta.dir, "../../../.."),
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
        ownedRbacAbsent: true,
        otherAccountRbacPresent: true,
        retryVerified: true,
        missingInventoryRefused: true,
        bindingReplacementRefused: true,
        roleReplacementRefused: true,
        wrongSubjectRefused: true,
        wrongRoleRefRefused: true,
        lateBindingRefused: true,
        lateRoleRefRefused: true,
        labelMismatchRefused: true,
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
