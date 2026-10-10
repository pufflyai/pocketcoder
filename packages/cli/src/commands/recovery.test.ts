import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import {
  RecoveryRequiredError,
  startPocketCoderServer,
  startRecoveryController,
} from "@pstdio/pocketcoder-server/lifecycle";
import { freePort, runCli } from "../testing/cli-test-support";

const KEYS = ["auth-pepper", "event-signing-key", "secret-key"];

test("a restored controller replays a later revocation in recovery before it serves again", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-recovery-cli-")));
  const source = join(root, "pc_data");
  const target = join(root, "restored");
  const port = freePort();
  const configFor = (directory: string) => ({
    ...loadConfig({ POCKETCODER_DIR: directory, POCKETCODER_HTTP: `127.0.0.1:${port}` }),
    agentPort: 0,
  });
  const owner = async (dir: string, ...extra: string[]) => {
    const issued = await runCli(["superuser", "create", "--dir", dir, "--json", ...extra]);
    expect(issued.exitCode).toBe(0);
    return JSON.parse(issued.output) as { token: string; key: { id: string; principal_id: string } };
  };
  let running: { stop(): Promise<void> } | undefined;
  try {
    const original = await startPocketCoderServer(configFor(source), { log: () => {} });
    running = original;
    // An owner rotation before the backup must not revoke the replacement when replayed.
    const first = await owner(source);
    const kept = await owner(source, "--replace");
    const revoked = await owner(source);
    const archive = join(root, "controller.tar");
    expect((await runCli(["backup", "create", "--dir", source, "--out", archive])).exitCode).toBe(0);
    // Only the deletion journal records this revocation; the backup still holds the key.
    const revoke = await fetch(`${original.url}/v1/principals/${revoked.key.principal_id}/keys/${revoked.key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${kept.token}` },
    });
    expect(revoke.status).toBe(200);
    await original.stop();
    running = undefined;

    const restored = await runCli(["backup", "restore", archive, "--dir", target]);
    expect(restored.exitCode).toBe(0);
    await expect(startPocketCoderServer(configFor(target), { log: () => {} })).rejects.toBeInstanceOf(
      RecoveryRequiredError,
    );
    const recovery = await startRecoveryController(configFor(target), { log: () => {} });
    running = recovery;
    // Recovery opens only the private socket.
    await expect(fetch(`http://127.0.0.1:${port}/livez`)).rejects.toThrow();
    const blocked = await runCli(["superuser", "create", "--dir", target, "--json"]);
    expect(blocked.output).toContain("recovery");
    const status = await runCli(["recovery", "status", "--dir", target]);
    expect(JSON.parse(status.output)).toMatchObject({ mode: "recovery", complete: false });
    const completed = await runCli(["recovery", "complete", "--dir", target]);
    expect(completed.exitCode).toBe(0);
    expect(JSON.parse(completed.output)).toMatchObject({ complete: true, workspaces: 0 });
    await recovery.stop();
    running = undefined;

    const service = await startPocketCoderServer(configFor(target), { log: () => {} });
    running = service;
    const ask = (token: string) =>
      fetch(`${service.url}/v1/principals/${kept.key.principal_id}/keys`, {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await ask(kept.token)).status).toBe(200);
    expect((await ask(first.token)).status).toBe(401);
    expect((await ask(revoked.token)).status).toBe(401);
    for (const name of KEYS)
      expect(await readFile(join(target, "keys", name))).toEqual(await readFile(join(source, "keys", name)));
    await service.stop();
    running = undefined;
    // The restore moved the journal's writer claim, so the old folder can no longer write.
    await expect(startPocketCoderServer(configFor(source), { log: () => {} })).rejects.toThrow("replaced by a restore");
  } finally {
    await running?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
