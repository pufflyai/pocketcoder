import { expect, test } from "bun:test";
import { generatedManagedContract } from "./artifacts";
import { managedRoutes } from "./routes";
import { managedSchemas } from "./schemas";
import { canTransitionRequest, canTransitionSession, ManagedQueueLimitsSchema } from "./states";

test("the shipped provisioning contract includes both empty responses and matching session status", () => {
  const { openapi } = generatedManagedContract();
  for (const [path, schema] of [
    ["/v1/budget-scopes/{scopeId}/grant", "BudgetScopeGrant"],
    ["/v1/credential-bindings/{bindingId}", "CredentialBinding"],
  ] as const) {
    const operation = openapi.paths[path]?.put as { "x-shipped": boolean; responses: object; requestBody: object };
    expect(operation?.["x-shipped"]).toBe(true);
    expect(operation.responses).toMatchObject({ "204": { description: expect.any(String) } });
    expect(operation.responses).not.toHaveProperty("200");
    expect(operation.responses).not.toHaveProperty("204.content");
    expect(operation.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
    });
  }
  const session = openapi.paths["/v1/sessions"]?.post as { responses: object };
  expect(session.responses).not.toHaveProperty("201");
});

test("generated schemas and proposed OpenAPI routes share the versioned contract", async () => {
  const generated = generatedManagedContract();
  const schema = await Bun.file(new URL("./generated/contracts.schema.json", import.meta.url)).json();
  const openapi = await Bun.file(new URL("./generated/openapi.json", import.meta.url)).json();
  expect(schema).toEqual(generated.schema);
  expect(openapi).toEqual(generated.openapi);
  expect(Object.keys(schema.$defs)).toEqual(Object.keys(managedSchemas));
  for (const route of managedRoutes) {
    const operation = openapi.paths[route.path][route.method];
    expect(operation["x-shipped"]).toBe(route.shipped);
    for (const match of route.path.matchAll(/\{(\w+)\}/g)) {
      expect(
        operation.parameters.some((p: { name: string; in: string }) => p.name === match[1] && p.in === "path"),
      ).toBe(true);
    }
  }
});

test("logical state transitions retain terminal outcomes and closed sessions", () => {
  expect(canTransitionRequest("accepted", "waiting")).toBe(true);
  expect(canTransitionRequest("running", "checking_outcome")).toBe(true);
  expect(canTransitionRequest("checking_outcome", "running")).toBe(true);
  expect(canTransitionRequest("terminal", "running")).toBe(false);
  expect(canTransitionSession("suspended", "provisioning")).toBe(true);
  expect(canTransitionSession("suspended", "ready")).toBe(false);
  expect(canTransitionSession("ready", "provisioning")).toBe(true);
  expect(canTransitionSession("failed", "provisioning")).toBe(true);
  expect(canTransitionSession("failed", "closed")).toBe(true);
  expect(canTransitionSession("closed", "ready")).toBe(false);
  expect(ManagedQueueLimitsSchema.safeParse({ requests: 0, bytes: 1 }).success).toBe(false);
  expect(ManagedQueueLimitsSchema.safeParse({ requests: 10, bytes: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
});
