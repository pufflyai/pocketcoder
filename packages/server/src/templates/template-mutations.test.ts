import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ApiError, parseTemplateManifest, TemplatePageSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { loadTemplateDir } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { type AppEnv, errorHandler, machineAuth, requestId } from "../http/middleware";
import { createStructuredLogger } from "../observability/observability";
import { registerCatalogRoutes } from "./catalog-routes";

const createStore = createTestStoreFactory();

async function fixture(scopes = ["templates:write"], names = ["fixture-echo"], keyNames = names, egressImage?: string) {
  const store = await createStore();
  const principal = await store.createPrincipal("publisher", scopes, names);
  const key = issueMachineKey("template-test");
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes,
    templateNames: keyNames,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const app = new OpenAPIHono<AppEnv>({
    defaultHook(result) {
      if (!result.success) throw new ApiError("validation.invalid", "Invalid template request.");
    },
  });
  app.use("*", requestId);
  app.onError(errorHandler(createStructuredLogger(() => {})));
  app.use("/v1/*", machineAuth(store, "template-test"));
  registerCatalogRoutes({ app, store, egressImage });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    });
  const publish = (manifest: unknown = fixtureTemplateEcho().manifest) =>
    request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) });
  return { app, store, principal, key, request, publish };
}

test("HTTP publishing computes canonical digests and keeps versions immutable", async () => {
  const f = await fixture();
  const original = fixtureTemplateEcho();
  const created = await f.publish();
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ name: "fixture-echo", digest: original.digest, status: "active" });
  expect((await f.publish()).status).toBe(200);
  const changed = { ...original.manifest, metadata: { ...original.manifest.metadata, description: "changed" } };
  const conflict = await f.publish(changed);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "template.version_immutable" } });
  expect((await f.store.getTemplate("fixture-echo", "1.0.0"))?.digest).toBe(original.digest);
});

test("template mutations require write scope and intersect principal and key name grants", async () => {
  for (const [scopes, names, keyNames, status] of [
    [["templates:read"], ["*"], ["*"], 403],
    [["templates:write"], ["*"], ["other"], 403],
    [["templates:write"], ["other"], ["other"], 403],
    [["admin"], ["other"], ["other"], 403],
  ] as const) {
    const f = await fixture([...scopes], [...names], [...keyNames]);
    expect((await f.publish()).status).toBe(status);
    expect((await f.request("/v1/templates/fixture-echo/1.0.0", { method: "DELETE" })).status).toBe(status);
    expect(await f.store.listTemplates(null)).toEqual([]);
  }
});

test("retirement preserves workspace snapshots and cannot reactivate the same version", async () => {
  const f = await fixture();
  await f.publish();
  const parsed = fixtureTemplateEcho();
  const template = await f.store.getTemplate("fixture-echo");
  if (!template) throw new Error("missing published template");
  const id = crypto.randomUUID();
  await f.store.insertWorkspace({
    id,
    principalId: f.principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: parsed.digest,
    templateId: template.id,
    templateSnapshot: { name: template.name, version: template.version, digest: template.digest, spec: template.spec },
    launchInput: {},
    metadata: {},
    deadlineAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  });
  const before = await f.store.getWorkspace(id);
  expect((await f.request("/v1/templates/fixture-echo/1.0.0", { method: "DELETE" })).status).toBe(200);
  expect((await f.publish()).status).toBe(200);
  expect((await f.store.getTemplate("fixture-echo", "1.0.0"))?.status).toBe("retired");
  expect(await f.store.getTemplate("fixture-echo")).toBeNull();
  expect((await f.store.getWorkspace(id))?.templateSnapshot).toEqual(before?.templateSnapshot);
  expect((await f.publish(fixtureTemplateEcho({ version: "1.1.0" }).manifest)).status).toBe(201);
  expect((await f.store.getTemplate("fixture-echo"))?.version).toBe("1.1.0");
  expect((await f.request("/v1/templates/fixture-echo/9.9.9", { method: "DELETE" })).status).toBe(404);
});

test("publish rechecks revoked keys and reduced name or scope grants after reading the body", async () => {
  for (const change of ["revoke", "names", "scopes"] as const) {
    const f = await fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ manifest: fixtureTemplateEcho().manifest })));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = f.request("/v1/templates", { method: "POST", body });
    try {
      await reading.promise;
      if (change === "revoke") await f.store.revokeMachineKey(f.key.id, new Date());
      else
        await f.store.updatePrincipal(
          f.principal.id,
          change === "scopes" ? [] : f.principal.scopes,
          change === "names" ? [] : f.principal.templateNames,
        );
    } finally {
      release.resolve();
    }
    expect((await request).status).toBe(change === "revoke" ? 401 : 403);
    expect(await f.store.listTemplates(null)).toEqual([]);
  }
});

test("publish rejects malformed, invalid and oversized bodies without storing templates", async () => {
  const f = await fixture();
  for (const body of [
    "{",
    JSON.stringify({ manifest: {} }),
    JSON.stringify({ manifest: { ...fixtureTemplateEcho().manifest, spec: {} } }),
  ]) {
    const response = await f.request("/v1/templates", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation.invalid" } });
  }
  const oversized = await f.request("/v1/templates", { method: "POST", body: " ".repeat(1_048_577) });
  expect(oversized.status).toBe(413);
  expect(await f.store.listTemplates(null)).toEqual([]);
  expect(parseTemplateManifest(fixtureTemplateEcho().manifest).digest).toBe(fixtureTemplateEcho().digest);
});

test("SDK publishes and retires templates through a real HTTP listener", async () => {
  const f = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: f.key.token });
    const parsed = fixtureTemplateEcho();
    expect(await client.templates.publish(parsed.manifest)).toMatchObject({ digest: parsed.digest, status: "active" });
    expect(await client.templates.retire("fixture-echo", "1.0.0")).toMatchObject({ status: "retired" });
  } finally {
    await server.stop(true);
  }
});

test("SDK lists every authorized version across page boundaries", async () => {
  const f = await fixture(["templates:read", "templates:write"]);
  const versions = [...Array.from({ length: 99 }, (_, index) => `1.0.0-${index}`), "1.0.0-a", "1.0.0-B"];
  for (const version of versions) {
    const response = await f.publish(fixtureTemplateEcho({ version }).manifest);
    if (response.status !== 201) throw new Error(`Publication failed: ${await response.text()}`);
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: f.key.token });
    const rows = await client.templates.list();
    expect(rows).toHaveLength(101);
    expect(new Set(rows.map((row) => row.version))).toEqual(new Set(versions));
  } finally {
    await server.stop(true);
  }
});

test("template cursor comparison matches sorting for mixed-case prerelease versions", async () => {
  const f = await fixture(["templates:read", "templates:write"]);
  await f.publish(fixtureTemplateEcho({ version: "1.0.0-a" }).manifest);
  await f.publish(fixtureTemplateEcho({ version: "1.0.0-B" }).manifest);
  const first = await f.request("/v1/templates?limit=1");
  const page = TemplatePageSchema.parse(await first.json());
  if (!page.next_cursor) throw new Error("missing next template page");
  const next = await f.request(`/v1/templates?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`);
  const second = TemplatePageSchema.parse(await next.json());
  expect([...page.items, ...second.items].map((row: { version: string }) => row.version)).toHaveLength(2);
  expect(new Set([...page.items, ...second.items].map((row: { version: string }) => row.version))).toEqual(
    new Set(["1.0.0-a", "1.0.0-B"]),
  );
});

test("startup import preserves HTTP publications and cannot reactivate a retired version", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "pc-template-import-"));
  try {
    await f.publish();
    expect((await loadTemplateDir(f.store, directory)).errors).toEqual([]);
    expect((await f.store.getTemplate("fixture-echo", "1.0.0"))?.status).toBe("active");
    await f.request("/v1/templates/fixture-echo/1.0.0", { method: "DELETE" });
    await writeFile(join(directory, "echo.json"), JSON.stringify(fixtureTemplateEcho().manifest));
    expect((await loadTemplateDir(f.store, directory)).errors).toEqual([]);
    expect((await f.store.getTemplate("fixture-echo", "1.0.0"))?.status).toBe("retired");
    expect(await f.store.getTemplate("fixture-echo")).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restricted publication succeeds when the controller has a pinned egress image", async () => {
  const f = await fixture(["templates:write"], ["*"], ["*"], `example.test/egress@sha256:${"e".repeat(64)}`);
  const manifest = fixtureTemplateEcho().manifest;
  const restricted = { ...manifest, spec: { ...manifest.spec, network: { mode: "restricted", allow: [] } } };
  expect((await f.publish(restricted)).status).toBe(201);
  expect((await f.store.getTemplate("fixture-echo"))?.spec.network.mode).toBe("restricted");
});

test("binding registry authority to a published template requires secrets administration", async () => {
  const manifest = fixtureTemplateEcho().manifest;
  const privateImage = { ...manifest, spec: { ...manifest.spec, imagePullSecret: "secretRef:pull" } };
  const publisher = await fixture();
  expect((await publisher.publish(privateImage)).status).toBe(403);
  expect(await publisher.store.listTemplates(null)).toEqual([]);
  const operator = await fixture(["templates:write", "secrets:write"]);
  expect((await operator.publish(privateImage)).status).toBe(201);
  expect((await operator.store.getTemplate("fixture-echo"))?.spec.imagePullSecret).toBe("secretRef:pull");
});

test("binding a source issuer requires secrets administration", async () => {
  const manifest = fixtureTemplateEcho().manifest;
  const source = {
    kind: "git",
    destinationMount: "worktree",
    repositories: { app: { url: "https://source.example/app.git", credential: "secretRef:source" } },
  };
  const privateSource = {
    ...manifest,
    spec: {
      ...manifest.spec,
      source,
      persistence: {
        ...manifest.spec.persistence,
        mounts: [{ name: "worktree", target: "/worktree", maxBytes: 1048576, maxFiles: 100 }],
      },
    },
  };
  const publisher = await fixture();
  expect((await publisher.publish(privateSource)).status).toBe(403);
  expect(await publisher.store.listTemplates(null)).toEqual([]);
  const operator = await fixture(["templates:write", "secrets:write"]);
  expect((await operator.publish(privateSource)).status).toBe(201);
});
