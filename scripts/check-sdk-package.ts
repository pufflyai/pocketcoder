import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPackageCommands } from "./check-package-commands";

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}

export async function packPackage(packageDir: string, destination: string, label: string) {
  const before = new Set(await readdir(destination));
  await run(["bun", "pm", "pack", "--destination", destination, "--ignore-scripts", "--quiet"], resolve(packageDir));
  const tarballName = (await readdir(destination)).find((entry) => entry.endsWith(".tgz") && !before.has(entry));
  if (!tarballName) throw new Error(`${label} pack did not produce a tarball`);
  return join(destination, tarballName);
}

async function installPackedDependencies(tempDir: string, tarballs: Record<string, string>) {
  const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]));
  await Bun.write(
    join(tempDir, "package.json"),
    `${JSON.stringify(
      {
        name: "pocketcoder-sdk-consumer",
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await run(["bun", "install", "--ignore-scripts", "--force", "--cache-dir", join(tempDir, "cache")], tempDir);
}

export async function checkSdkPackage(packageDir: string, cliPackageDir: string) {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-package-tarballs-"));
  try {
    await checkPackedPackages({
      "@pstdio/pocketcoder-sdk": await packPackage(packageDir, directory, "SDK"),
      "@pstdio/pocketcoder-cli": await packPackage(cliPackageDir, directory, "CLI"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkPackedPackages(tarballs: Record<string, string>) {
  const tempDir = await mkdtemp(join(tmpdir(), "pocketcoder-sdk-consumer-"));

  try {
    await Bun.write(
      join(tempDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ["ES2024", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2024",
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    await Bun.write(
      join(tempDir, "consumer.ts"),
      `import { PocketCoderClient, type RestoreRequest, type WorkspaceResource, WorkspaceTurnResolver } from "@pstdio/pocketcoder-sdk";

const restore: RestoreRequest = {
  external_id: "restored-workspace",
  launch_input: { bootstrap_token: "short-lived-envelope" },
};
const useWorkspace = (workspace: WorkspaceResource) => workspace.id;
const client = new PocketCoderClient({
  baseUrl: "https://pocketcoder.test",
  apiKey: "workspace-scoped-key",
});
const resolver = new WorkspaceTurnResolver({
  client,
  resumeWorkspace: async ({ source }) => source,
});

void restore;
void useWorkspace;
void resolver;
void client.templates.list();
`,
    );
    await Bun.write(
      join(tempDir, "consumer.mjs"),
      `import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";

let request;
const server = createServer((incoming, response) => {
  request = incoming;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ items: [], next_cursor: null }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");

let upgradeSocket;
try {
  const client = new PocketCoderClient({
    baseUrl: \`http://127.0.0.1:\${address.port}\`,
    apiKey: "workspace-scoped-key",
  });
  assert.deepEqual(await client.templates.list(), []);
  assert.equal(request.url, "/v1/templates?limit=100");
  assert.equal(request.headers.authorization, "Bearer workspace-scoped-key");
  const upgrade = once(server, "upgrade", { signal: AbortSignal.timeout(1_000) });
  const terminalClient = new PocketCoderClient({
    baseUrl: \`http://127.0.0.1:\${address.port}\`,
    apiKey: "workspace-scoped-key",
  });
  terminalClient.terminals.connect("workspace-id").onError(() => {});
  const [upgradeRequest, socket] = await upgrade;
  upgradeSocket = socket;
  assert.equal(upgradeRequest.headers.authorization, "Bearer workspace-scoped-key");
  assert.equal(upgradeRequest.url, "/v1/workspaces/workspace-id/terminal");
} finally {
  upgradeSocket?.destroy();
  server.close();
}
`,
    );

    await installPackedDependencies(tempDir, tarballs);
    await run([join(import.meta.dir, "../node_modules/.bin/tsc"), "--project", "tsconfig.json"], tempDir);
    await checkPackageCommands(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
