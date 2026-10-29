import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPostgresTestDatabase, TEST_DATABASE_URL } from "@pstdio/pocketcoder-db/testing";
import { freePort } from "../testing/cli-test-support";

// PC-151: a database URL alone selects PostgreSQL for `pcd serve`.
test.skipIf(!TEST_DATABASE_URL)(
  "pcd serve runs on PostgreSQL when a database URL is set",
  async () => {
    const database = await createPostgresTestDatabase("pc_cli_serve");
    const directory = await mkdtemp(join(tmpdir(), "pc-cli-serve-"));
    const port = freePort();
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", resolve(import.meta.dir, "../index.ts"), "serve", "--dir", directory],
      {
        env: {
          ...Bun.env,
          POCKETCODER_DATABASE_URL: database.url,
          POCKETCODER_AUTH_PEPPER: "cli-serve-pepper",
          POCKETCODER_JOURNAL_DIR: database.journalDir,
          POCKETCODER_HTTP: `127.0.0.1:${port}`,
          POCKETCODER_AGENT_HTTP: `127.0.0.1:${freePort()}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output: string[] = [];
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of child.stderr) output.push(decoder.decode(chunk));
    })();
    void (async () => {
      for await (const chunk of child.stdout) output.push(decoder.decode(chunk));
    })();
    try {
      let live = false;
      for (let attempt = 0; attempt < 100 && !live && child.exitCode === null; attempt++) {
        live = await fetch(`http://127.0.0.1:${port}/livez`).then(
          (response) => response.ok,
          () => false,
        );
        if (!live) await Bun.sleep(100);
      }
      expect({ live, output: live ? "" : output.join("") }).toEqual({ live: true, output: "" });
      expect(output.join("")).toContain("store: postgres (schema pocketcoder)");
    } finally {
      child.kill();
      await child.exited;
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
