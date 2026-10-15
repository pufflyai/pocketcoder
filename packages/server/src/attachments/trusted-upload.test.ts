import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createTestServer, fakeAgent, readyWorkspace, uploadRequest } from "./attachments-support.test";

const createStore = createTestStoreFactory();
test("requires a digest before transferring any attachment bytes", async () => {
  const server = await createTestServer(await createStore());
  const id = await readyWorkspace(server);
  const agent = fakeAgent(server, id);
  const response = await server.app.request(
    `/v1/workspaces/${id}/attachments/${randomUUID()}`,
    uploadRequest(server.token, new Uint8Array([1]), { "x-content-sha256": "" }),
  );
  expect(response.status).toBe(400);
  expect(agent.frames).toEqual([]);
});
