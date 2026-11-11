import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestServer, fakeAgent, readyWorkspace, uploadRequest } from "./attachments-support.test";

const createStore = createTestStoreFactory();

test("HTTP upload persists canonical references without workload transfer or connection", async () => {
  const server = await createTestServer(await createStore());
  const id = await readyWorkspace(server);
  const fileId = randomUUID();
  const response = await server.app.request(
    `/v1/workspaces/${id}/attachments/${fileId}`,
    uploadRequest(server.token, Buffer.from("original")),
  );
  expect(response.status).toBe(201);
  const reference = await response.json();
  expect(reference).toMatchObject({ workspaceId: id, fileId, visibility: "ready", sizeBytes: 8, name: "notes.txt" });
  expect(reference).not.toHaveProperty("path");
  const retry = await server.app.request(
    `/v1/workspaces/${id}/attachments/${fileId}`,
    uploadRequest(server.token, Buffer.from("original")),
  );
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(reference);
  const changed = await server.app.request(
    `/v1/workspaces/${id}/attachments/${fileId}`,
    uploadRequest(server.token, Buffer.from("mutation")),
  );
  expect(changed.status).toBe(409);
});

test("HTTP enforces scope, descriptor and configured file bound", async () => {
  const server = await createTestServer(await createStore());
  const id = await readyWorkspace(server);
  const agent = fakeAgent(server, id);
  const path = `/v1/workspaces/${id}/attachments/${randomUUID()}`;
  expect((await server.app.request(path, uploadRequest(server.relayOnlyToken, new Uint8Array(1)))).status).toBe(403);
  expect(
    (await server.app.request(path, uploadRequest(server.token, new Uint8Array(1), { "content-length": "1048577" })))
      .status,
  ).toBe(413);
  expect(
    (
      await server.app.request(
        path,
        uploadRequest(server.token, new Uint8Array(1), { "x-content-sha256": "a".repeat(64) }),
      )
    ).status,
  ).toBe(400);
  expect(agent.frames).toEqual([]);
});
