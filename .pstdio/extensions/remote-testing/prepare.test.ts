import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareExtension } from "./prepare";

test("the distributable inlines the private protocol and has no workspace dependency", async () => {
  const out = await mkdtemp(join(tmpdir(), "remote-testing-package-"));
  try {
    await prepareExtension(out);
    const manifest = await Bun.file(join(out, "package.json")).json();
    expect(manifest.main).toBe("./extension.js");
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    const code = await Bun.file(join(out, "extension.js")).text();
    expect(code).not.toContain('from "@pstdio/pocketcoder-example-test-runner');
    expect(await Bun.file(join(out, "skills/run-tests-remotely/SKILL.md")).exists()).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
