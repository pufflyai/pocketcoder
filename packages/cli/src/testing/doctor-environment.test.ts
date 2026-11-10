import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli-test-support";

describe("pcd environment", () => {
  test("loads .env from the nearest project directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const nested = join(directory, "nested");
    mkdirSync(nested);
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(join(directory, ".env"), `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`);

      const result = await runCli(["workspaces", "list"], { cwd: nested });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("(no workspaces)");
      expect(authorizations).toEqual(["Bearer from-dotenv"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps exported environment variables above .env values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(join(directory, ".env"), `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`);

      const result = await runCli(["workspaces", "list"], {
        cwd: directory,
        env: { POCKETCODER_KEY: "from-shell" },
      });

      expect(result.exitCode).toBe(0);
      expect(authorizations).toEqual(["Bearer from-shell"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("supports explicit work directories and environment files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
    const invocationDirectory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-cwd-"));
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json({ items: [], next_cursor: null });
      },
    });
    try {
      writeFileSync(
        join(directory, "staging.env"),
        `POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-explicit-file\n`,
      );

      const result = await runCli(["--workdir", directory, "--env-file", "staging.env", "workspaces", "list"], {
        cwd: invocationDirectory,
      });

      expect(result.exitCode).toBe(0);
      expect(authorizations).toEqual(["Bearer from-explicit-file"]);
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
      rmSync(invocationDirectory, { recursive: true, force: true });
    }
  });
});
