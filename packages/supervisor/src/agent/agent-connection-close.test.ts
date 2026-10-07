// Proves transport closure joins the actual close event and its admitted cleanup.
import { expect, test } from "bun:test";
import { ProviderInputSchema } from "@pstdio/pocketcoder-contracts";
import { AgentConnection } from "./agent-connection";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("connection close joins original disconnect cleanup", async () => {
  const registered = deferred();
  const disconnected = deferred();
  const cleanup = deferred();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade", { status: 426 });
    },
    websocket: {
      message() {
        registered.release();
      },
    },
  });
  const connection = new AgentConnection(
    ProviderInputSchema.parse({
      workspace_id: crypto.randomUUID(),
      server_url: String(server.url),
      registration_secret: "synthetic-registration",
      template_name: "fixture",
      template_version: "1.0.0",
      template_digest: "sha256:close",
      launch_mode: "create",
    }),
    {
      services: () => [],
      onMessage() {},
      onRegistrationFailure() {},
      isStopped: () => true,
      onDisconnect: async () => {
        disconnected.release();
        await cleanup.promise;
      },
    },
  );
  try {
    connection.connect();
    await registered.promise;
    let closed = false;
    const closing = Promise.resolve(connection.close()).then(() => {
      closed = true;
    });
    await disconnected.promise;
    await Bun.sleep(20);
    expect(closed).toBe(false);
    cleanup.release();
    await closing;
    expect(closed).toBe(true);
  } finally {
    cleanup.release();
    await connection.close();
    await server.stop(true);
  }
}, 5000);
