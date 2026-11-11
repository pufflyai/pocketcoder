import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import { HEADER_PROTOCOL, HEADER_RECONNECT, HEADER_WORKSPACE, managed } from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "@pstdio/pocketcoder-db/testing";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { agentConnectValidator } from "./ws-auth";

test("a managed workspace with template credentials refuses a supervisor too old for session leases", async () => {
  const f = await executionFixture();
  const server = await createTestServer(f.store, { globalActiveWorkspaces: 0 });
  const app = new Hono();
  app.use("*", agentConnectValidator({ ...server, store: f.store, pepper: SERVER_TEST_PEPPER }));
  app.get("/", (c) => c.body(null, 204));
  try {
    const row = await f.store.getWorkspace(f.id);
    if (!row) throw new Error("Missing workspace");
    const snapshot = structuredClone(row.templateSnapshot);
    snapshot.spec.env.TOKEN_FILE = "secretRef:runtime";
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        templateSnapshot: snapshot,
        metadata: { [managed.MANAGED_SESSION_METADATA]: randomUUID() },
        reconnectDigest: digestOpaque(SERVER_TEST_PEPPER, "reconnect"),
      })
      .where(eq(f.context.tables.workspaces.id, f.id));
    const connect = (protocol: number) =>
      app.request("/", {
        headers: { [HEADER_PROTOCOL]: String(protocol), [HEADER_WORKSPACE]: f.id, [HEADER_RECONNECT]: "reconnect" },
      });
    const old = await connect(14);
    expect(old.status).toBe(401);
    expect(await old.text()).toContain("Session credentials require agent protocol version 15");
    expect((await connect(15)).status).toBe(204);
  } finally {
    await f.dispose();
  }
});
