import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePersistentPi } from "./persistent-pi";

test("restoring keeps the session path and replaces the gateway credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "persistent-pi-"));
  try {
    const first = await preparePersistentPi(root, {
      url: "http://gateway.test/v1",
      model: "test",
      api: "openai-completions",
      bearer: "first-workspace",
    });
    const second = await preparePersistentPi(root, {
      url: "http://new-gateway.test/v1",
      model: "test",
      api: "openai-completions",
      bearer: "second-workspace",
    });
    expect(second).toEqual(first);
    expect(second).toContain("--continue");
    expect(second).toContain("/state/pi");
    const config = await Bun.file(join(root, "models.json")).text();
    expect(config).toContain("second-workspace");
    expect(config).not.toContain("first-workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
