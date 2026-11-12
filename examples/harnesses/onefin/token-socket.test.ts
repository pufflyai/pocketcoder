import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenSocket } from "./token-socket";

test("The external agent tools can read the current scoped credential over the Unix socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-onefin-token-"));
  const path = join(root, "token.sock");
  const server = await tokenSocket(path, async () => "workspace-scoped-token");
  try {
    const token = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (value) => {
        body += value;
      });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    expect(token).toBe("workspace-scoped-token");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
