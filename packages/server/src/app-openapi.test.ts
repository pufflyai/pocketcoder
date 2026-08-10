import { describe, expect, test } from "bun:test";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { createTestServer } from "./test-server.test";

describe("openapi", () => {
  test("serves the generated document", async () => {
    const { app } = await createTestServer();
    const res = await app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get?: {
            operationId?: string;
            tags?: string[];
            parameters?: Array<{ name: string; in: string; required?: boolean }>;
            responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          };
          post?: {
            operationId?: string;
            tags?: string[];
            parameters?: Array<{ name: string; in: string; required?: boolean }>;
            responses: Record<string, unknown>;
          };
          put?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
          patch?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
          delete?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
        }
      >;
    };
    expect(Object.keys(doc.paths)).toContain("/v1/workspaces");
    expect(Object.keys(doc.paths)).toContain("/v1/templates");
    expect(doc.paths["/v1/workspaces"]?.post?.parameters).toContainEqual(
      expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true,
      }),
    );
    for (const path of [
      "/v1/templates",
      "/v1/workspaces",
      "/v1/workspaces/{id}/checkpoints",
      "/v1/workspaces/{id}/conversation",
      "/v1/workspaces/{id}/outputs",
      "/v1/workspaces/{id}/network-events",
      "/v1/workspaces/{id}/logs",
    ]) {
      const queryNames =
        doc.paths[path]?.get?.parameters
          ?.filter((parameter) => parameter.in === "query")
          .map((parameter) => parameter.name) ?? [];
      expect(queryNames).toContain("cursor");
      expect(queryNames).not.toContain("after");
    }
    for (const path of Object.values(doc.paths)) {
      for (const operation of [path.get, path.post, path.put, path.patch, path.delete]) {
        if (!operation) continue;
        expect(operation.operationId).toBeString();
        expect(operation.tags?.length).toBeGreaterThan(0);
        for (const status of ["400", "401", "403"]) {
          expect(operation.responses).toHaveProperty(status);
        }
      }
    }
  });
});

describe("typed client conformance", () => {
  test("validates real Hono responses without a parallel DTO layer", async () => {
    const server = await createTestServer({ globalActiveWorkspaces: 0 });
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      server.app.request(input, init)) as typeof fetch;
    const client = new PocketCoderClient(
      { baseUrl: "http://pocketcoder.test", apiKey: server.token },
      fetchImpl,
    );

    const templates = await client.templates.list();
    expect(templates.map((template) => template.name)).toContain("fixture-echo");
    const created = await client.workspaces.create({
      externalId: "client-conformance",
      templateName: "fixture-echo",
    });
    expect((await client.workspaces.get(created.id)).external_id).toBe("client-conformance");
  });
});
