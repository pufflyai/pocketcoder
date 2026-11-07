import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createTestServer } from "../testing/test-server.test";
import { type PreviewSession, PreviewSessions } from "./sessions";

const createStore = createTestStoreFactory();

test("repeated stream cleanup preserves a newer stream for the same grant", async () => {
  const server = await createTestServer(await createStore());
  const sessions = new PreviewSessions(server.store, server.service);
  const session: PreviewSession = {
    workspaceId: "workspace",
    name: "web",
    origin: "https://view.example",
    keyId: "key",
    expires: Date.now() + 60000,
    mode: "top_level",
    grantId: "grant",
  };
  const remove = sessions.track(session, () => {});
  remove();
  let closed = false;
  const removeCurrent = sessions.track(session, () => {
    closed = true;
  });
  remove();
  expect(sessions.pendingStreams("grant")).toBe(1);
  sessions.closeGrant("grant");
  expect(closed).toBe(true);
  removeCurrent();
  expect(sessions.pendingStreams("grant")).toBe(0);
});
