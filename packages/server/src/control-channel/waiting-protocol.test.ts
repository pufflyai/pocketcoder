import { expect, test } from "bun:test";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import {
  HEADER_PROTOCOL,
  HEADER_RECONNECT,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "@pstdio/pocketcoder-db/testing";
import { Hono } from "hono";
import { createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { agentConnectValidator, execSpecOf } from "./ws-auth";

test.each([12, 13])("waiting runtimes reject protocol %s before registration and reconnect", async (protocol) => {
  const f = await executionFixture(undefined, { ready: false });
  const server = await createTestServer(f.store, { globalActiveWorkspaces: 0 });
  const app = new Hono();
  app.use("*", agentConnectValidator({ ...server, store: f.store, pepper: SERVER_TEST_PEPPER }));
  app.get("/", (c) => c.body(null, 204));
  try {
    const registrationDigest = digestOpaque(SERVER_TEST_PEPPER, "registration");
    await f.store.updateWorkspace(
      f.id,
      {
        reconnectDigest: digestOpaque(SERVER_TEST_PEPPER, "reconnect"),
        registrationDigest,
        registrationExpiresAt: new Date(Date.now() + 60000),
      },
      new Date(),
    );
    for (const header of [HEADER_REGISTRATION, HEADER_RECONNECT]) {
      const response = await app.request("/", {
        headers: {
          [HEADER_PROTOCOL]: String(protocol),
          [HEADER_WORKSPACE]: f.id,
          [header]: "reconnect",
        },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("requires protocol version 14");
    }
    const current = await app.request("/", {
      headers: {
        [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
        [HEADER_WORKSPACE]: f.id,
        [HEADER_RECONNECT]: "reconnect",
      },
    });
    expect(current.status).toBe(204);
    const row = await f.store.getWorkspace(f.id);
    expect(row?.registrationDigest).toEqual(registrationDigest);
    if (!row) throw new Error("Missing waiting workspace");
    expect(execSpecOf(row, null, "provider_installed").workload).toMatchObject({
      serviceHealth: {},
      manualServices: [],
    });
  } finally {
    await f.dispose();
  }
});
