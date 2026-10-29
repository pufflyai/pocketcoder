import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli-test-support";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("the admission map is rendered from the principal file without a controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-cli-principal-file-"));
  directories.push(directory);
  const file = join(directory, "principals.json");
  await writeFile(
    file,
    JSON.stringify({
      principals: [{ name: "backend", scopes: ["workspaces:read"], templates: [], admission_template: "standard" }],
    }),
  );
  const first = await runCli(["principals", "admission-map", "--file", file]);
  expect(first.exitCode).toBe(0);
  const map = JSON.parse(first.output);
  expect(map.principals).toEqual([
    { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "backend", admission_template: "standard" },
  ]);
  const second = await runCli(["principals", "admission-map", "--file", file]);
  expect(JSON.parse(second.output)).toEqual(map);
});
