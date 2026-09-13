import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimDaemon } from "./daemon-lock";

test("concurrent startup attempts cannot replace the session owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-owner-"));
  try {
    const claims = await Promise.all([claimDaemon(directory), claimDaemon(directory)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims.find((claim) => claim !== undefined);
    if (!owner) throw new Error("Expected one daemon owner");
    await Bun.write(join(directory, "connection.json"), "saved session");
    expect(await claimDaemon(directory)).toBeUndefined();
    expect(await Bun.file(join(directory, "connection.json")).text()).toBe("saved session");
    await owner.release();
    const next = await claimDaemon(directory);
    expect(next).toBeDefined();
    await next?.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
