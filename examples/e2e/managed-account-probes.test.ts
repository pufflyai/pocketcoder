import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { requestManagedAccount } from "./managed-account-probes";

test("account probes use a fresh connection after a forwarded socket is retired", async () => {
  const retired = new WeakSet<Socket>();
  const accepted: { method: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    if (retired.has(request.socket)) {
      request.socket.resetAndDestroy();
      return;
    }
    retired.add(request.socket);
    accepted.push({ method: request.method, authorization: request.headers.authorization });
    response.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP address missing");
  const owner = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "workspace-test-key",
    namespace: "test",
    accountId: "test",
  };
  try {
    expect(await (await requestManagedAccount(owner, "/readyz")).text()).toBe("ok");
    const result = await requestManagedAccount(owner, "/cancel", {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
    expect(await result.text()).toBe("ok");
    expect(accepted).toEqual([
      { method: "GET", authorization: "Bearer workspace-test-key" },
      { method: "POST", authorization: "Bearer workspace-test-key" },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
