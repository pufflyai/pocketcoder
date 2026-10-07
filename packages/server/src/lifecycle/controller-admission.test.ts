// Proves real HTTP admission retains detached database work and refuses new requests.
import { expect, test } from "bun:test";
import { authed, createTestServer } from "../testing/test-server.test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("HTTP completion does not discard its detached machine key write", async () => {
  const server = await createTestServer();
  const entered = deferred();
  const release = deferred();
  const original = server.store.touchMachineKey.bind(server.store);
  server.store.touchMachineKey = async (...args) => {
    entered.resolve();
    await release.promise;
    await original(...args);
  };
  const response = await server.app.request("/v1/templates", authed(server.token));
  expect(response.status).toBe(200);
  await entered.promise;
  let closed = false;
  const closing = server.operations.close().then(() => {
    closed = true;
  });
  try {
    await Bun.sleep(5);
    expect(closed).toBe(false);
  } finally {
    release.resolve();
    await closing;
  }
});

test("closed controller admission returns an explicit HTTP conflict", async () => {
  const server = await createTestServer();
  await server.operations.close();
  const response = await server.app.request("/v1/templates", authed(server.token));
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("operation.conflict");
});
