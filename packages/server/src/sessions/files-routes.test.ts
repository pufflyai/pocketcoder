import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { managed, sha256Hex } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import { managedFixture, provisionManaged } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver, FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";

test.each(["memory", "disk"] as const)("public session files upload exact bytes without compute (%s)", async (mode) => {
  const f = await managedFixture(mode);
  const root = await mkdtemp(join(tmpdir(), "pc-session-files-"));
  const token = issueMachineKey("test-pepper");
  await f.store.insertMachineKey({
    id: token.id,
    principalId: f.principal.id,
    secretDigest: token.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    revokedAt: null,
    lastUsedAt: null,
  });
  await provisionManaged(f);
  const inputStorageOptions = {
    driver: new FilesystemInputStorage(root, []),
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
  };
  let store = f.store;
  const build = () =>
    buildServer({
      store,
      driver: new DockerDriver(),
      pepper: "test-pepper",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://localhost",
      inputStorageOptions,
      sessionQueueLimits: { count: 2, bytes: 1048576 },
    });
  let server = build();
  const base = `/v1/sessions/${f.sessionId}`;
  const call = (path: string, method = "GET", body?: string, contentType = "application/json", name = "test.txt") =>
    server.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token.token}`, "content-type": contentType, "x-pocketcoder-file-name": name },
      ...(body === undefined ? {} : { body }),
    });
  try {
    const bytes = "exact UTF-8 bytes: café";
    const input = {
      inputId: randomUUID(),
      name: "test.txt",
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(bytes),
      sha256: `sha256:${sha256Hex(Buffer.from(bytes))}`,
    };
    expect((await call(`${base}/inputs/${input.inputId}`, "PUT", bytes, "text/plain", "../escape")).status).toBe(400);
    expect((await call(`${base}/inputs/${input.inputId}`, "PUT", bytes, "invalid")).status).toBe(400);
    const uploaded = await call(`${base}/inputs/${input.inputId}`, "PUT", bytes, "text/plain");
    expect(uploaded.status).toBe(200);
    const registered = managed.InputObjectSchema.parse(await uploaded.json());
    expect(registered.state).toBe("ready");
    expect((await call(`${base}/inputs/${input.inputId}`, "PUT", bytes, "text/plain")).status).toBe(200);
    expect((await call(`${base}/inputs/${input.inputId}`, "PUT", "different bytes", "text/plain")).status).toBe(409);
    const body = {
      requestId: randomUUID(),
      message: "read the uploaded test",
      attachments: [registered.reference.inputId],
    };
    const accepted = await call(`${base}/requests`, "POST", JSON.stringify(body));
    expect(accepted.status).toBe(200);
    const receipt = await accepted.json();
    expect(receipt).toMatchObject({ state: "accepted", collection: { state: "pending", objects: [] } });
    expect(await (await call(`${base}/requests`, "POST", JSON.stringify(body))).json()).toEqual(receipt);
    expect((await call(`${base}/requests`, "POST", JSON.stringify({ ...body, message: "changed" }))).status).toBe(409);
    expect((await call(`${base}/requests/${body.requestId}/collection`)).status).toBe(200);
    if (mode === "disk") {
      await server.executionDispatcher.stop();
      await server.scheduler.drain();
      await store.close();
      store = await DatabaseStore.openPGlite(f.directory);
      server = build();
      expect(await (await call(`${base}/requests`, "POST", JSON.stringify(body))).json()).toEqual(receipt);
    }
    expect((await call(`/v1/sessions/${randomUUID()}/inputs/${input.inputId}`)).status).toBe(404);
    expect(await store.listNonterminal()).toHaveLength(0);
    const descriptor = await store.managed.files.upload(f.keyId, f.sessionId, input.inputId);
    const stored = await store.inputs.get(descriptor.reference.workspaceId, input.inputId);
    if (!stored) throw Error("Missing canonical input");
    const actual = await inputStorageOptions.driver.read(
      { workspaceId: descriptor.reference.workspaceId, fileId: input.inputId, versionId: stored.reservationId },
      descriptor.reference,
    );
    expect(await new Response(actual).text()).toBe(bytes);
  } finally {
    await server.executionDispatcher.stop();
    await server.scheduler.drain();
    if (store !== f.store) await store.close();
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
