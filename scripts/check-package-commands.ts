import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

export async function checkPackageCommands(directory: string) {
  const tools = join(directory, "tools");
  await mkdir(tools);
  const node = Bun.which("node") ?? "";
  if (!node) throw new Error("Node is required for package checks");
  await symlink(node, join(tools, "node"));
  const env = { PATH: tools, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "pi") };
  async function run(args: string[], extraEnv = {}) {
    const child = Bun.spawn([node, ...args], {
      cwd: directory,
      env: { ...env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${error}`);
    return output;
  }
  await run(["consumer.mjs"]);
  const cli = await Bun.file(join(directory, "node_modules/@pstdio/pocketcoder-cli/package.json")).json();
  if ((await run(["node_modules/.bin/pcd", "--version"])).trim() !== cli.version)
    throw new Error("Installed CLI version differs");
  if (!(await run(["node_modules/.bin/pcd", "backup", "--help"])).includes("restore"))
    throw new Error("Installed CLI commands missing");
  // Help loads the actual Pi launcher; this placeholder grants no server authority.
  const help = await run(["node_modules/.bin/pocketcoder-remote", "--help"], {
    POCKETCODER_KEY: "help-only-no-authority",
  });
  if (!help.includes("--extension")) throw new Error("Installed remote launcher did not load Pi");
}
