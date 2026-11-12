import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { registerServerTestCleanup } from "../testing/test-server-cleanup";
import type { managedFixture } from "./managed-fixture.test";

// The real HTTP app over the managed fixture's store, reached by the real SDK. The fixture's own
// dispatcher runs work on its producer; this server only serves the public API.
export async function sdkClient(m: Awaited<ReturnType<typeof managedFixture>>, options: { stopSeconds?: number } = {}) {
  const key = issueMachineKey("test-pepper");
  await m.f.store.insertMachineKey({
    id: key.id,
    principalId: m.f.principal.id,
    secretDigest: key.secretDigest,
    scopes: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const server = buildServer({
    store: m.f.store,
    driver: new FakeDriver(),
    pepper: "test-pepper",
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
    sessionQueueLimits: m.limits,
    sessionEventPollMs: 10,
    // Baseline fixture bounds from the managed tickets; not production defaults.
    inputStorageOptions: {
      driver: new FilesystemInputStorage(await mkdtemp(join(tmpdir(), "pc-sdk-inputs-")), []),
      limits: {
        fileBytes: 1048576,
        stagedBytes: 8388608,
        files: 16,
        transfers: 2,
        transferMs: 1000,
        retentionMs: 600000,
      },
      capacity: async () => ({
        workspace: { bytes: 8388608, files: 16 },
        principal: { bytes: 16777216, files: 32 },
        instance: { bytes: 33554432, files: 64 },
        freeDisk: { bytes: 67108864, files: 128, headroomBytes: 0, headroomFiles: 0 },
      }),
    },
  });
  registerServerTestCleanup(m.f.store, server);
  const fetchApp = ((input: string | URL | Request, init?: RequestInit) =>
    server.app.request(input instanceof Request ? input : input.toString(), init)) as typeof fetch;
  return {
    server,
    client: new PocketCoderClient({ baseUrl: "http://127.0.0.1:8090", apiKey: key.token, fetch: fetchApp }),
  };
}
