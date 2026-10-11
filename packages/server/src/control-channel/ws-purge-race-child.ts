import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import { ApiError, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createAccountPurgeReader } from "@pstdio/pocketcoder-db/off-node";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { bootstrapLocalOwnerKey, DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { startAdminSocket } from "../administration/admin-socket";
import { registerPurgeAdmin } from "../administration/purge-admin";
import { buildServer } from "../app";
import { openControllerStore } from "../bootstrap/controller-store";
import { accountPurgeFence } from "../maintenance/account-purge";
import { createMaintenance } from "../maintenance/maintenance";
import { createPurgeCleanup } from "../maintenance/purge-cleanup";

const configPath = process.argv[2];
if (!configPath) throw new Error("Socket fixture config path is required");
const config = await Bun.file(configPath).json();
const initialized = await openControllerStore(config.directory);
const store = initialized.store;
let agent: ReturnType<typeof Bun.serve> | undefined;
let admin: Awaited<ReturnType<typeof startAdminSocket>> | undefined;
let built: ReturnType<typeof buildServer> | undefined;
let cleanup: Awaited<ReturnType<typeof createPurgeCleanup>> | undefined;
try {
  const owner = await bootstrapLocalOwnerKey(store, initialized.keys.pepper, {
    request_id: randomUUID(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const snapshot = snapshotOf(
    parseTemplateManifest(
      await Bun.file(join(import.meta.dir, "../../../../examples/harnesses/echo/template.json")).json(),
    ),
  );
  const template = await store.upsertTemplate({ ...snapshot, description: null });
  const workspaceId = randomUUID();
  const registration = generateOpaqueSecret();
  const at = new Date();
  await store.insertWorkspace({
    id: workspaceId,
    principalId: owner.key.principal_id,
    externalId: workspaceId,
    idempotencyKey: workspaceId,
    requestDigest: workspaceId,
    templateId: template.row.id,
    templateSnapshot: snapshot,
    launchInput: null,
    metadata: {},
    createdAt: at,
    deadlineAt: new Date(Date.now() + 60_000),
  });
  await store.transition(workspaceId, {
    from: ["queued"],
    to: "provisioning",
    at,
    patch: {
      registrationDigest: digestOpaque(initialized.keys.pepper, registration),
      registrationExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const maintenance = createMaintenance();
  const read = createAccountPurgeReader({ accountId: config.accountId, storage: config.storage });
  // The provider is real and unreachable. This slice cannot claim physical compute deletion.
  const driver = new DockerDriver({ inputDir: join(config.directory, "inputs") });
  built = buildServer({
    store,
    driver,
    maintenance,
    assertAccountAllowed: accountPurgeFence(read),
    pepper: initialized.keys.pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  cleanup = await createPurgeCleanup({ directory: config.directory, read, store, driver, maintenance, runtime: built });
  agent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.agentApp.fetch, websocket: built.websocket });
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 16_384 }));
  app.onError((error, context) => {
    if (error instanceof ApiError)
      return context.json({ error: { code: error.code } }, error.status as ContentfulStatusCode);
    return context.json({ error: { code: "fixture.failed" } }, 500);
  });
  registerPurgeAdmin(app, cleanup);
  const runtime = built;
  app.get("/fixture/state", async (context) => {
    const key = await store.getMachineKeyWithPrincipal(owner.key.id);
    const row = await store.getWorkspace(workspaceId);
    return context.json({
      conversationCount: (await store.readConversation(workspaceId, 0, 10)).length,
      hubPresent: runtime.hub.get(workspaceId) !== undefined,
      revoked: Boolean(key?.key.revokedAt),
      state: row?.state ?? "missing",
    });
  });
  admin = await startAdminSocket(config.directory, app.fetch);
  await writeFile(
    join(dirname(config.directory), "issued.json"),
    JSON.stringify({
      workspaceId,
      keyId: owner.key.id,
      registration,
      digest: snapshot.digest,
    }),
    { mode: 0o600 },
  );
  console.log(`WS_PURGE_CHILD ${JSON.stringify({ ready: agent.port, pid: process.pid })}`);
  for await (const _bytes of Bun.stdin.stream()) {
    /* EOF owns shutdown. */
  }
} finally {
  await admin?.stop();
  await agent?.stop(true);
  await cleanup?.drain();
  await built?.scheduler.drain();
  await built?.persistence.drain();
  await store.close();
}
process.exit(0);
