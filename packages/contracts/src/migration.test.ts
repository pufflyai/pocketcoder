import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const LEGACY_IDENTIFIERS =
  /coder-lite|CODER_LITE_|X-Coder-Lite-Signature|\/run\/coder-lite|\/opt\/coder-lite|coder-lite-agent/;
const TEXT_FILE = /\.(?:ts|tsx|js|mjs|json|jsonc|yml|yaml|md)$/;

describe("coder-lite migration freeze", () => {
  test("ships legacy public identifiers only in the migration guide", async () => {
    const repository = resolve(import.meta.dir, "../../..");
    const roots = ["apps", "packages", "deploy", "examples", "docs", ".github", "scripts"];
    const matches: string[] = [];
    const listed = Bun.spawnSync({
      cmd: ["git", "ls-files", "-co", "--exclude-standard", "--", ...roots],
      cwd: repository,
    });
    expect(listed.exitCode).toBe(0);
    for (const path of listed.stdout.toString().trim().split("\n")) {
      if (
        !TEXT_FILE.test(path) ||
        path === "docs/migration.md" ||
        path.endsWith("/migration.test.ts")
      ) {
        continue;
      }
      const file = Bun.file(resolve(repository, path));
      if (!(await file.exists())) continue;
      const text = await file.text();
      if (LEGACY_IDENTIFIERS.test(text)) matches.push(path);
    }
    const readme = await Bun.file(resolve(repository, "README.md")).text();
    if (LEGACY_IDENTIFIERS.test(readme)) matches.push("README.md");

    expect(matches).toEqual([]);
  });
});
