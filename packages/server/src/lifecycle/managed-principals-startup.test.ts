import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedPrincipalId } from "../bootstrap/managed-principals/principal-file";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";

const dockerAvailable =
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!dockerAvailable)(
  "a fresh controller comes up with its declared principals and their keys, and a restart changes nothing",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-managed-principals-"));
    const tokenPath = join(dir, "backend.token");
    const principalsFile = join(dir, "principals.json");
    await writeFile(
      principalsFile,
      JSON.stringify({
        principals: [
          {
            name: "backend",
            scopes: ["workspaces:read"],
            templates: [],
            key: { target: { kind: "file", path: tokenPath } },
          },
        ],
      }),
    );
    const messages: string[] = [];
    let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
    try {
      const config = {
        ...loadConfig({
          POCKETCODER_DIR: join(dir, "data"),
          POCKETCODER_AUTH_PEPPER: "disposable-test-pepper",
          POCKETCODER_PRINCIPALS_FILE: principalsFile,
        }),
        listenHost: "127.0.0.1",
        listenPort: 0,
        agentPort: 0,
      };
      const tokens: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        running = await startPocketCoderServer(config, { log: (message) => messages.push(message) });
        const token = await readFile(tokenPath, "utf8");
        tokens.push(token);
        expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
        const listed = await fetch(`${running.url}/v1/workspaces`, { headers: { authorization: `Bearer ${token}` } });
        expect(listed.status).toBe(200);
        await running.stop();
        running = undefined;
      }
      expect(tokens[1]).toBe(tokens[0]);
      expect(messages.join("\n")).toContain(managedPrincipalId("backend"));
      expect(messages.join("\n")).not.toContain("pkt_");
    } finally {
      await running?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
