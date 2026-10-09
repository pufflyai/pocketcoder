import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "@pstdio/pocketcoder-server";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { runCli } from "./cli-test-support";

const createStore = createTestStoreFactory();

test("principal commands use the running server without opening its database", async () => {
  const store = await createStore();
  const pepper = "cli-principals-test-pepper";
  const owner = await store.createPrincipal("owner", ["admin"], ["*"]);
  const key = issueMachineKey(pepper);
  await store.insertMachineKey({
    id: key.id,
    principalId: owner.id,
    secretDigest: key.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const built = buildServer({
    store,
    driver: new FakeDriver(),
    pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch });
  const env = { POCKETCODER_URL: listener.url.origin, POCKETCODER_KEY: key.token };
  try {
    const created = await runCli(
      [
        "principals",
        "create",
        "--name",
        "cli-customer",
        "--scopes",
        "workspaces:read",
        "--templates",
        "fixture-echo",
        "--json",
      ],
      { env },
    );
    expect(created.exitCode).toBe(0);
    const customer = JSON.parse(created.output) as { id: string; name: string };
    expect(await store.getPrincipal(customer.id)).toMatchObject({ name: "cli-customer" });
    const listed = await runCli(["principals", "list", "--json"], { env });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.output).items).toContainEqual(customer);
    const detail = await runCli(["principals", "get", "--id", customer.id, "--json"], { env });
    expect(detail.exitCode).toBe(0);
    expect(JSON.parse(detail.output)).toEqual(customer);
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const issueArguments = [
      "keys",
      "issue",
      "--principal-id",
      owner.id,
      "--request-id",
      "cli-recovery",
      "--scopes",
      "keys:read,keys:write,workspaces:recover",
      "--templates",
      "fixture-echo",
      "--manage-principals",
      customer.id,
      "--expires",
      expiresAt,
      "--json",
    ];
    const issued = await runCli(issueArguments, { env });
    expect(issued.exitCode).toBe(0);
    const result = JSON.parse(issued.output);
    expect(result.token).toStartWith("pkt_");
    expect(result.key).toMatchObject({ managed_principal_ids: [customer.id], templates: ["fixture-echo"] });
    const replay = await runCli(issueArguments, { env });
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.output)).toMatchObject({ key: { id: result.key.id }, token: null });
    const updated = await runCli(["principals", "update", "--id", customer.id, "--disabled", "--json"], { env });
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.output).disabled_at).toBeString();
    expect(await store.getPrincipal(customer.id)).toMatchObject({ disabledAt: expect.any(Date) });
  } finally {
    await listener.stop(true);
    await built.scheduler.drain();
    await built.persistence.drain();
  }
});
