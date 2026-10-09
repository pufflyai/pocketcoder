import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { supervise } from "@pstdio/pocketcoder-supervisor";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 1500;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Missing ${label}`);
    await Bun.sleep(10);
  }
}

test("source-only issuer expiry stops stalled Git setup and prevents the harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-source-expiry-"));
  const marker = join(root, "processes.json");
  const harness = join(root, "harness-started");
  const releaseGit = Promise.withResolvers<void>();
  const gitRequested = Promise.withResolvers<void>();
  const gitServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      gitRequested.resolve();
      await releaseGit.promise;
      return new Response("stopped", { status: 503 });
    },
  });
  const f = await leaseServiceFixture("memory", `http://127.0.0.1:${gitServer.port}/app.git`);
  let processes: { setup: number; git: number } | null = null;
  let supervisorDone: Promise<number> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let built: ReturnType<typeof buildServer> | null = null;
  try {
    const setupPath = join(root, "setup.ts");
    await writeFile(
      setupPath,
      `const source = JSON.parse(process.env.POCKETCODER_SOURCE);
const git = Bun.spawn(["git", "-c", "http.extraHeader=Authorization: Bearer " + source.credential, "clone", source.url, source.destination], { stdout: "inherit", stderr: "inherit" });
await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ setup: process.pid, git: git.pid }));
process.exit(await git.exited);
`,
    );
    await f.vault.put(f.key.id, "source", { ...f.config, type: "setup-issuer" });
    f.issuer.controls.leaseLifetimeMs = 800;
    const snapshot = snapshotOf(f.parsed);
    snapshot.spec.env = {};
    snapshot.spec.setup = [
      { name: "clone", command: [process.execPath, setupPath], env: {}, timeoutSeconds: 10, runOn: ["create"] },
    ];
    snapshot.spec.harness = {
      command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(harness)}, "started")`],
      env: {},
    };
    snapshot.spec.security.writableMemoryPaths = [];
    snapshot.spec.persistence.mounts = [
      { name: "worktree", target: join(root, "worktree"), maxBytes: 1048576, maxFiles: 100 },
    ];
    snapshot.spec.source = {
      kind: "git",
      destinationMount: "worktree",
      allowedRevision: "branch-tag-or-commit",
      repositories: { app: { url: `http://127.0.0.1:${gitServer.port}/app.git`, credential: "secretRef:source" } },
    };
    const id = randomUUID();
    await f.store.insertWorkspace({
      id,
      principalId: f.principal.id,
      externalId: id,
      idempotencyKey: id,
      requestDigest: digestOf(id),
      templateId: f.template.id,
      templateSnapshot: snapshot,
      launchInput: null,
      metadata: {},
      sourceDescriptor: { kind: "git", repository: "app", revision: "main" },
      deadlineAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    const registration = randomUUID();
    await f.store.transition(id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: {
        registrationDigest: digestOpaque(f.pepper, registration),
        registrationExpiresAt: new Date(Date.now() + 60000),
      },
    });
    built = buildServer({
      store: f.store,
      driver: new FakeDriver(),
      pepper: f.pepper,
      secretKey: f.encryptionKey.toString("base64url"),
      issuerClient: createIssuerClient({ ca: f.issuer.ca }),
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:1",
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.agentApp.fetch, websocket: built.websocket });
    const inputPath = join(root, "input.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        workspace_id: id,
        server_url: `http://127.0.0.1:${server.port}`,
        registration_secret: registration,
        template_name: snapshot.name,
        template_version: snapshot.version,
        template_digest: snapshot.digest,
        launch_mode: "create",
        launch_input: {},
      }),
    );
    supervisorDone = supervise(inputPath);
    await waitFor(() => Bun.file(marker).exists(), "setup process marker");
    const started: { setup: number; git: number } = JSON.parse(await readFile(marker, "utf8"));
    processes = started;
    await gitRequested.promise;
    expect(alive(started.git)).toBe(true);
    expect(await f.issuer.resource(f.issuer.controls.captured, id)).toBe(200);
    expect(await f.store.listPendingWorkspaceLeases(id)).toHaveLength(1);
    const outcome = await Promise.race([supervisorDone, Bun.sleep(1600).then(() => "still-running")]);
    expect(alive(started.setup)).toBe(false);
    expect(alive(started.git)).toBe(false);
    expect(outcome).toBe(30);
    expect(await Bun.file(harness).exists()).toBe(false);
    expect((await f.store.getWorkspace(id))?.state).not.toBe("ready");
    expect(await f.issuer.resource(f.issuer.controls.captured, id)).toBe(401);
  } finally {
    releaseGit.resolve();
    if (processes)
      for (const pid of [processes.git, processes.setup]) {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    await supervisorDone?.catch(() => {});
    await server?.stop(true);
    await gitServer.stop(true);
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
