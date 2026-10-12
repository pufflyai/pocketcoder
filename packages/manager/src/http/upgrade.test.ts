import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";

test("a resolved upgrade keeps its manifest and operation across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc92-upgrade-"));
  let store = await ManagerStore.create(directory);
  const data = { pglite: "0.5.8", postgres: "18.3", migrations: [{ name: "initial", hash: "a".repeat(64) }] };
  const source = {
    version: "1.0.0-rc.1",
    controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
    data,
    agentProtocol: 11,
  };
  const target = {
    ...source,
    version: "1.0.0-rc.2",
    controllerImage: `controller.test/server@sha256:${"b".repeat(64)}`,
    upgradesFrom: [source.version],
    rollbackTo: [source.version],
    evidence: "https://example.test/validated-run",
  };
  const config = {
    controllerImage: source.controllerImage,
    runtimeClassName: "pc-runc",
    offNodeBackups: true,
    releases: [{ ...source, upgradesFrom: [], rollbackTo: [], evidence: target.evidence }, target],
  };
  try {
    const expiry = new Date(Date.now() + 60_000);
    const token = await store.createOperator(expiry);
    const created = await store.createAccount(
      "one",
      { name: "one" },
      () => ({ controllerImage: source.controllerImage, runtimeClassName: "pc-runc", offNodeBackups: true }),
      expiry,
    );
    await store.finishAccount(created.account.id, created.operation.id);
    // Repository admission needs no cluster. Its saved identity replays through the real HTTP route.
    await store.beginUpgrade(created.account.id, "upgrade-one", target.version, config.releases, expiry);
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": "upgrade-one",
      "content-type": "application/json",
    };
    const path = `/v1/accounts/${created.account.id}/upgrade`;
    let app = createManagerApp(store, config);
    const admitted = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: target.version }),
    });
    expect(admitted.status).toBe(202);
    const result = z
      .object({ operation: z.object({ id: z.uuid() }).passthrough() })
      .passthrough()
      .parse(await admitted.json());
    expect(result).toMatchObject({
      account: { state: "upgrading" },
      operation: { kind: "upgrade", phase: "fence", upgrade: { source, target } },
    });
    expect(
      (
        await app.request(`/v1/accounts/${created.account.id}/suspend`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": "suspend" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await app.request(path, { method: "POST", headers, body: JSON.stringify({ version: source.version }) })).status,
    ).toBe(409);
    await store.close();
    store = await ManagerStore.create(directory);
    app = createManagerApp(store, { ...config, releases: [] });
    const repeated = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: target.version }),
    });
    expect(repeated.status).toBe(202);
    expect(z.object({ operation: z.object({ id: z.uuid() }) }).parse(await repeated.json()).operation.id).toBe(
      result.operation.id,
    );
    expect(await store.pendingOperations()).toMatchObject([
      { id: result.operation.id, kind: "upgrade", phase: "fence" },
    ]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
