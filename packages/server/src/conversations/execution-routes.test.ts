import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { executionFixture, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { authed } from "../testing/test-server.test";

test.each(["process", "conversation-request"])("start without conversation identity for %s", async (owner) => {
  const f = await executionFixture(owner === "conversation-request" ? serviceExecutionTemplate : undefined);
  try {
    const key = issueMachineKey("execution-route-fixture");
    const workspace = await f.store.getWorkspace(f.id);
    if (!workspace) throw new Error("Fixture workspace missing");
    await f.store.insertMachineKey({
      id: key.id,
      principalId: f.principal.id,
      secretDigest: key.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: workspace.deadlineAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    const { app } = buildServer({
      store: f.store,
      driver: new DockerDriver(),
      pepper: "execution-route-fixture",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://localhost",
    });
    const input = f.acceptance();
    const response = await app.request(
      `/v1/workspaces/${f.id}/executions`,
      authed(key.token, { method: "POST", body: JSON.stringify({ acceptance: input }) }),
    );
    if (owner === "conversation-request") {
      expect(response.status).toBe(400);
      expect(await f.store.executions.get(input.execution)).toBeNull();
      expect(await f.store.inputs.getManifest(executionInputManifestId(input))).toBeNull();
    } else {
      expect(response.status).toBe(201);
      expect((await f.store.executions.get(input.execution))?.phase).toBe("accepted");
    }
  } finally {
    await f.dispose();
  }
});
