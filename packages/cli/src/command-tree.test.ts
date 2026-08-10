import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCli } from "./cli-test-support";

describe("yargs command tree", () => {
  test.each([
    {
      args: ["--help"],
      usage: "pcd <command>",
      details: ["workspaces", "templates", "server"],
    },
    {
      args: ["workspaces", "--help"],
      usage: "pcd workspaces <command>",
      details: ["create", "chat", "terminal"],
    },
    {
      args: ["workspaces", "chat", "--help"],
      usage: "pcd workspaces chat",
      details: ["--id", "--message", "--follow", "--response-timeout-seconds"],
    },
    {
      args: ["templates", "render", "--help"],
      usage: "pcd templates render <manifest>",
      details: ["--image", "--set", "--out"],
    },
  ])("shows scoped help for $usage", async ({ args, usage, details }) => {
    const result = await runCli(args);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(usage);
    for (const detail of details) expect(result.output).toContain(detail);
  });

  test("createCli.parseAsync runs the selected command handler", async () => {
    const entry = resolve(import.meta.dir, "command-tree.ts");
    const template = resolve(import.meta.dir, "../../../examples/templates/fixture-echo.json");
    const script = [
      `import { createCli } from ${JSON.stringify(entry)};`,
      `await createCli(["templates", "validate", ${JSON.stringify(template)}]).parseAsync();`,
    ].join("\n");
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fixture-echo@1.0.0");
  });

  test("action help does not load the project environment", async () => {
    const result = await runCli([
      "--workdir",
      "/definitely/missing/pocketcoder-project",
      "workspaces",
      "chat",
      "--help",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pcd workspaces chat");
    expect(result.output).not.toContain("work directory does not exist");
  });
});
