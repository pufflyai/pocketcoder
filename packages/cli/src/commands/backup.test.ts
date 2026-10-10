import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { runCli } from "../testing/cli-test-support";

test("backup create writes an archive of the running controller that verify accepts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-backup-cli-"));
  const out = await realpath(await mkdtemp(join(tmpdir(), "pc-backup-cli-out-")));
  const config = { ...loadConfig({ POCKETCODER_DIR: directory }), listenPort: 0, agentPort: 0 };
  const running = await startPocketCoderServer(config, { log: () => {} });
  try {
    const owner = await runCli(["superuser", "create", "--dir", directory, "--json"]);
    expect(owner.exitCode).toBe(0);
    const { token } = JSON.parse(owner.output) as { token: string };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const template = JSON.stringify({ manifest: fixtureTemplateEcho().manifest });
    expect((await fetch(`${running.url}/v1/templates`, { method: "POST", headers, body: template })).status).toBe(201);

    const output = join(out, "controller.tar");
    const created = await runCli(["backup", "create", "--dir", directory, "--out", output]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.output)).toMatchObject({ output, checkpoints: 0 });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    // Writes resume as soon as the backup finishes.
    expect((await fetch(`${running.url}/v1/templates`, { method: "POST", headers, body: template })).status).toBe(200);

    const verified = await runCli(["backup", "verify", output]);
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.output)).toMatchObject({
      ok: true,
      snapshot_id: JSON.parse(created.output).snapshot_id,
    });

    const inside = await runCli(["backup", "create", "--dir", directory, "--out", join(directory, "inside.tar")]);
    expect(inside.exitCode).not.toBe(0);
    expect(inside.output).toContain("outside");
    expect(await readdir(out)).toEqual(["controller.tar"]);
  } finally {
    await running.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);
