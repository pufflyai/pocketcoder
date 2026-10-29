import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AccountPurgeIntent } from "@pstdio/pocketcoder-contracts";
import { loadOffNodeConfig } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";

async function start(directory: string, config: string) {
  const availablePort = () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    return port;
  };
  const operatorPort = availablePort();
  const agentPort = availablePort();
  const script = `import {loadConfig} from './packages/server/src/config/config';
    import {runPocketCoderServerUntilSignal} from './packages/server/src/lifecycle/lifecycle';
    await runPocketCoderServerUntilSignal({...loadConfig(),listenPort:${operatorPort},agentPort:${agentPort}},{log:()=>{}});`;
  const child = Bun.spawn(["bun", "--no-env-file", "-e", script], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: {
      ...process.env,
      POCKETCODER_DIR: directory,
      POCKETCODER_OFF_NODE_CONFIG: config,
      DOCKER_HOST: `unix://${directory}/unreachable-docker.sock`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try {
        await fetch("http://localhost/v1/account", { unix: join(directory, "admin.sock") });
        break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`Purge child exited: ${await stderr}`);
      if (Date.now() > deadline) throw new Error("Purge child startup timed out");
      await Bun.sleep(10);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    await Promise.all([stdout, stderr]);
    throw error;
  }
  return {
    operatorPort,
    agentPort,
    async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      child.kill(signal);
      const code = await child.exited;
      await stdout;
      const errors = await stderr;
      if (signal === "SIGTERM" && code !== 0) throw new Error(`Purge child exit ${code}: ${errors}`);
    },
  };
}

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "private purge revokes real keys before unreachable compute and retries privately after SIGKILL",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-private-purge-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let child: Awaited<ReturnType<typeof start>> | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const directory = join(root, "controller");
      const accountId = randomUUID();
      const outerKey = join(root, "outer-key");
      await writeFile(outerKey, randomBytes(32), { mode: 0o600 });
      const path = join(root, "off-node.json");
      await writeFile(path, JSON.stringify({ accountId, storage: fixture.config, encryptionKeyFile: outerKey }), {
        mode: 0o600,
      });
      const controller = await openControllerStore(directory);
      try {
        await (await loadOffNodeConfig(path)).journal.acknowledge(controller.store.journalSnapshot());
      } finally {
        await controller.store.close();
      }
      child = await start(directory, path);
      const request = (route: string, body?: object) =>
        fetch(`http://localhost${route}`, {
          unix: join(directory, "admin.sock"),
          ...(body
            ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        });
      const owner = await request("/v1/owner", {
        request_id: randomUUID(),
        automation: true,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(owner.status).toBe(201);
      const issued = (await owner.json()) as { key: { id: string } };
      const intent: AccountPurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId,
        operationId: randomUUID(),
        createRequestDigest: "c".repeat(64),
        purgeRequestDigest: "d".repeat(64),
        admittedAt: new Date().toISOString(),
      };
      for (const key of [
        `manager/purge/accounts/${accountId}/intent.json`,
        `manager/purge/requests/${intent.createRequestDigest}/intent.json`,
      ]) {
        const receipt = await fixture.storage.putIfAbsent(key, Buffer.from(JSON.stringify(intent)));
        expect(await (await fixture.storage.get(key, receipt.versionId)).json()).toEqual(intent);
      }
      const purge = await request("/v1/account/purge", { operation_id: intent.operationId });
      expect(purge.status).toBe(503);
      expect(await purge.json()).toMatchObject({ error: { code: "account.purge_pending" } });
      const status = await request("/v1/account/purge");
      expect(await status.json()).toMatchObject({
        mode: "purging",
        operation_id: intent.operationId,
        operation_state: "pending",
      });
      const keyState = await request(`/v1/account/purge/keys/${issued.key.id}`);
      expect(await keyState.json()).toMatchObject({
        account_id: accountId,
        operation_id: intent.operationId,
        key: { id: issued.key.id, revoked_at: expect.any(String) },
      });
      const marker = await Bun.file(join(directory, "account-purge.json")).json();
      expect(marker.intent).toEqual(intent);
      const journalVersions = await fixture.storage.versions(`accounts/${accountId}/journal/`);
      await child.stop("SIGKILL");
      child = undefined;
      child = await start(directory, path);
      for (const port of [child.operatorPort, child.agentPort])
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      expect((await request("/v1/owner", { request_id: randomUUID() })).status).toBe(409);
      expect(await (await request("/v1/account/purge")).json()).toMatchObject({
        mode: "purging",
        operation_id: intent.operationId,
        operation_state: "pending",
      });
      expect((await request("/v1/account/purge", { operation_id: randomUUID() })).status).toBe(409);
      expect((await request("/v1/account/purge", { operation_id: intent.operationId })).status).toBe(503);
      expect((await Bun.file(join(directory, "account-purge.json")).json()).intent).toEqual(intent);
      expect(await fixture.storage.versions(`accounts/${accountId}/journal/`)).toEqual(journalVersions);
      expect(await (await request(`/v1/account/purge/keys/${issued.key.id}`)).json()).toMatchObject({
        key: { id: issued.key.id, revoked_at: marker.keysRevokedAt },
      });
      // Exercise completion authority arrival, without claiming physical provider cleanup.
      await fixture.storage.clean(`accounts/${accountId}/`);
      await fixture.storage.putIfAbsent(
        `manager/purge/accounts/${accountId}/complete.json`,
        Buffer.from(
          JSON.stringify({
            format: "pocketcoder-account-purge-completion/v1",
            intent,
            completedAt: new Date().toISOString(),
          }),
        ),
      );
      expect((await request("/v1/account/purge", { operation_id: intent.operationId })).status).toBe(409);
      expect(await fixture.storage.versions(`accounts/${accountId}/`)).toEqual([]);
      expect(await fixture.storage.multipart(`accounts/${accountId}/`)).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      for (const result of await Promise.allSettled([child?.stop()]))
        if (result.status === "rejected") errors.push(result.reason);
      for (const result of await Promise.allSettled([fixture?.close(), rm(root, { recursive: true, force: true })]))
        if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...errors], "Private purge fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
