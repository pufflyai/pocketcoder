import { expect, test } from "bun:test";
import { parseTemplateManifest, type WorkspaceResource, WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

function manifest(version: string, agent: { type: string; model?: string }) {
  return parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "fixture-echo" },
    spec: {
      version,
      image: `example.test/agent@sha256:${"a".repeat(64)}`,
      agent: { ...agent, command: ["private-command"], env: { PRIVATE_SETTING: "private-value" } },
      resources: { cpu: "1", memory: "1Gi" },
    },
  }).manifest;
}

test("HTTP and SDK resources keep agent metadata from each immutable template snapshot", async () => {
  const f = await createTestServer(await createStore(), { globalActiveWorkspaces: 0 });
  const identity = await f.store.getMachineKeyWithPrincipal(f.keyId);
  if (!identity) throw new Error("missing test principal");
  await f.store.updatePrincipal(
    identity.principal.id,
    [...identity.principal.scopes, "templates:write"],
    identity.principal.templateNames,
  );
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  const client = new PocketCoderClient({ baseUrl: listener.url.toString(), apiKey: f.token });
  try {
    const original = { type: "custom", model: "first-model" };
    expect(await client.templates.publish(manifest("2.0.0", original))).toMatchObject({ agent: original });
    const created = await client.workspaces.create({ externalId: "original", templateName: "fixture-echo" });
    expect(created).toMatchObject({ agent: original });

    const next = { type: "codex", model: "second-model" };
    await client.templates.publish(manifest("3.0.0", next));
    expect(await client.templates.retire("fixture-echo", "2.0.0")).toMatchObject({ agent: original });
    expect(await client.workspaces.get(created.id)).toMatchObject({ agent: original });
    expect((await client.workspaces.change(created.id, 0, 0)).workspace).toMatchObject({ agent: original });
    expect(await client.workspaces.create({ externalId: "original", templateName: "fixture-echo" })).toMatchObject({
      id: created.id,
      agent: original,
    });
    const newer = await client.workspaces.create({ externalId: "newer", templateName: "fixture-echo" });
    expect(newer).toMatchObject({ agent: next });

    await client.templates.publish(manifest("4.0.0", { type: "claude" }));
    const unspecified = await client.workspaces.create({ externalId: "unspecified", templateName: "fixture-echo" });
    const legacy = await client.workspaces.create({
      externalId: "legacy",
      templateName: "fixture-echo",
      templateVersion: "1.0.0",
    });
    const expected = new Map<string, WorkspaceResource["agent"]>([
      [created.id, original],
      [newer.id, next],
      [unspecified.id, { type: "claude", model: null }],
      [legacy.id, null],
    ]);
    for (const [id, agent] of expected) {
      const response = await f.app.request(`/v1/workspaces/${id}`, authed(f.token));
      expect(response.status).toBe(200);
      expect(WorkspaceResourceSchema.parse(await response.json()).agent).toEqual(agent);
      expect(await client.workspaces.get(id)).toMatchObject({ agent });
    }
    const workspaces = await client.workspaces.list();
    expect(workspaces.items).toHaveLength(4);
    for (const workspace of workspaces.items) expect(workspace).toMatchObject({ agent: expected.get(workspace.id) });

    const versions = new Map<string, WorkspaceResource["agent"]>([
      ["1.0.0", null],
      ["2.0.0", original],
      ["3.0.0", next],
      ["4.0.0", { type: "claude", model: null }],
    ]);
    const templates = (await client.templates.list()).filter((item) => item.name === "fixture-echo");
    expect(templates).toHaveLength(4);
    for (const item of templates) expect(item).toMatchObject({ agent: versions.get(item.version) });

    for (const path of ["/v1/templates", "/v1/templates/fixture-echo", "/v1/workspaces"]) {
      const response = await f.app.request(path, authed(f.token));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("private-command");
      expect(text).not.toContain("PRIVATE_SETTING");
      expect(text).not.toContain("private-value");
      if (path === "/v1/templates/fixture-echo") {
        for (const item of JSON.parse(text).versions) expect(item.agent).toEqual(versions.get(item.version));
      }
    }
  } finally {
    await listener.stop(true);
  }
});
