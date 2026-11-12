import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionEnvironment } from "./session-env";

test("a session with its own leases sees only its own credential paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-session-env-"));
  const [own, other] = [randomUUID(), randomUUID()];
  try {
    await mkdir(join(root, "sessions", own), { recursive: true });
    const env = { TOKEN_FILE: join(root, "runtime"), HOME: "/home/agent" };
    expect(sessionEnvironment(env, own, root)).toEqual({
      TOKEN_FILE: join(root, "sessions", own, "runtime"),
      HOME: "/home/agent",
    });
    // A conversation without its own leases keeps the workspace credential.
    expect(sessionEnvironment(env, other, root)).toEqual(env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
