import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ExecutionRecordSchema } from "@pstdio/pocketcoder-contracts";
import { executionFixture, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { authed } from "../testing/test-server.test";

test("a caller submits file references without physical fingerprints and retries the same request", async () => {
  const f = await executionFixture((source) => {
    serviceExecutionTemplate(source);
    const operation = source.spec.operations.run;
    if (!operation) throw new Error("Missing fixture operation");
    source.spec.operations.message = {
      ...operation,
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    };
  });
  try {
    const key = issueMachineKey("agent-request-fixture");
    await f.store.insertMachineKey({
      id: key.id,
      principalId: f.principal.id,
      secretDigest: key.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastUsedAt: null,
    });
    const { app } = buildServer({
      store: f.store,
      driver: new DockerDriver(),
      pepper: "agent-request-fixture",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://localhost",
    });
    const input = { requestId: randomUUID(), conversationId: randomUUID(), message: "Read my file", files: [] };
    const path = `/v1/workspaces/${f.id}/requests`;
    const submit = (body = input) =>
      app.request(path, authed(key.token, { method: "POST", body: JSON.stringify(body) }));
    const created = await submit();
    expect(created.status).toBe(201);
    let record = ExecutionRecordSchema.parse(await created.json());
    expect(record.acceptance.input).toEqual({ message: input.message });
    expect(record.acceptance.execution.owner).toBe("conversation-request");
    expect((await submit()).status).toBe(200);
    expect((await submit({ ...input, message: "Changed input" })).status).toBe(409);
    const read = await app.request(
      `${path}/${input.requestId}?conversationId=${input.conversationId}`,
      authed(key.token),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(record);
    const history = await app.request(`${path}?conversationId=${input.conversationId}`, authed(key.token));
    expect(await history.json()).toEqual({ items: [record], next_cursor: null });
    record = await f.store.executions.cancel(
      { execution: record.acceptance.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    await f.store.executions.finalize(record.acceptance.execution, new Date());
    record = ExecutionRecordSchema.parse(await f.store.executions.get(record.acceptance.execution));
    const next = { ...input, requestId: randomUUID(), message: "Next turn" };
    expect((await submit(next)).status).toBe(201);
    const firstPage = await app.request(`${path}?conversationId=${input.conversationId}&limit=1`, authed(key.token));
    expect(await firstPage.json()).toEqual({ items: [record], next_cursor: input.requestId });
    const secondPage = await app.request(
      `${path}?conversationId=${input.conversationId}&limit=1&cursor=${input.requestId}`,
      authed(key.token),
    );
    const page = (await secondPage.json()) as { items: unknown[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(ExecutionRecordSchema.parse(page.items[0]).acceptance.input).toEqual({ message: "Next turn" });
    expect(page.next_cursor).toBeNull();
    const unrelated = await app.request(`${path}?conversationId=${randomUUID()}`, authed(key.token));
    expect(await unrelated.json()).toEqual({ items: [], next_cursor: null });
    const badCursor = await app.request(
      `${path}?conversationId=${randomUUID()}&cursor=${input.requestId}`,
      authed(key.token),
    );
    expect(badCursor.status).toBe(400);
    const foreign = await app.request(`${path}/${input.requestId}?conversationId=${randomUUID()}`, authed(key.token));
    expect(foreign.status).toBe(404);
  } finally {
    await f.dispose();
  }
});
