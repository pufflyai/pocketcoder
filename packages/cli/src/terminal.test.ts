import { describe, expect, test } from "bun:test";
import { runCli } from "./cli-test-support";

describe("pcd terminal workflow", () => {
  test("bridges terminal output and exits with the remote command code", async () => {
    const workspaceId = "55555555-5555-4555-8555-555555555555";
    const sessionId = "66666666-6666-4666-8666-666666666666";
    let authorization = "";
    const server = Bun.serve<{ authorized: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        authorization = request.headers.get("authorization") ?? "";
        if (
          bunServer.upgrade(request, {
            data: { authorized: authorization === "Bearer terminal-key" },
          })
        ) {
          return;
        }
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message() {},
        open(socket) {
          if (!socket.data.authorized) {
            socket.close(1008, "unauthorized");
            return;
          }
          setTimeout(() => {
            socket.send(JSON.stringify({ type: "opened", session_id: sessionId }));
            socket.send(
              JSON.stringify({
                type: "output",
                data_b64: Buffer.from("terminal output\n").toString("base64"),
              }),
            );
            socket.send(JSON.stringify({ type: "closed", reason: "exit", exit_code: 3 }));
          }, 10);
        },
      },
    });
    try {
      const result = await runCli(["workspaces", "terminal", "--id", workspaceId], {
        env: {
          POCKETCODER_URL: server.url.origin,
          POCKETCODER_KEY: "terminal-key",
        },
        keepStdinOpen: true,
      });
      expect(result).toMatchObject({
        exitCode: 3,
        output: expect.stringContaining("terminal output"),
      });
      expect(authorization).toBe("Bearer terminal-key");
    } finally {
      await server.stop(true);
    }
  }, 5000);
});
