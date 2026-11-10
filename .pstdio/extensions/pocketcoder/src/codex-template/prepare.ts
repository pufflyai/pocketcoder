import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../../..");
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { cwd: repo, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`${args[0]} failed.`);
};
await command(["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"]);
await command(["docker", "build", "-t", "pocketcoder-workspace:dev", "deploy/image"]);
await command(["docker", "build", "-t", "pocketcoder-pstdio-codex:local", import.meta.dir]);
const inspect = Bun.spawn(["docker", "image", "inspect", "pocketcoder-pstdio-codex:local", "--format", "{{.Id}}"], {
  stdout: "pipe",
  stderr: "inherit",
});
const digest = (await new Response(inspect.stdout).text()).trim();
if (await inspect.exited) throw new Error("Cannot inspect the built image.");
const manifest = {
  apiVersion: "pocketcoder.dev/v1alpha1",
  kind: "Template",
  metadata: {
    name: "prompt-studio-codex",
    description:
      "Prompt Studio and Codex in a disposable local machine. Cloud enrollment is required before relay chat.",
  },
  spec: {
    version: `1.0.0-local.${digest.slice(7, 19)}`,
    image: `pocketcoder-pstdio-codex:local@${digest}`,
    harness: { command: ["bun", "/opt/pstdio-tools/start.ts"] },
    resources: { cpu: "2", memory: "2Gi" },
    security: { readOnlyRoot: false },
    services: {
      pstdio: {
        baseUrl: "http://127.0.0.1:19841",
        healthPath: "/connection",
        routes: [{ method: "GET", path: "/connection" }],
      },
    },
    timeouts: { start: "2m", maxAge: "1h", idle: "20m", terminateGrace: "10s" },
  },
};
const path = join(repo, ".pstdio/extension-storage/pocketcoder.pocketcoder/templates/prompt-studio-codex.json");
await Bun.write(path, JSON.stringify(manifest, null, 2));
console.log(`Prepared ${manifest.metadata.name}@${manifest.spec.version}\n${path}`);
