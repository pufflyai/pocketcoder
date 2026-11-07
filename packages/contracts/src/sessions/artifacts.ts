import { z } from "zod";
import { managedRoutes } from "./routes";
import { MANAGED_CONTRACT_REVISION, managedSchemas } from "./schemas";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string, media = "application/json") => ({
  [media]: { schema: name === "bytes" ? { type: "string", format: "binary" } : ref(name) },
});

function parametersFor(route: (typeof managedRoutes)[number]) {
  const parameters: object[] = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema:
      match[1] === "revision"
        ? { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
        : { type: "string", format: "uuid" },
  }));
  if (route.path.startsWith("/v1/execution-profiles/"))
    parameters.push({ name: "principalId", in: "query", required: true, schema: { type: "string", format: "uuid" } });
  if (route.path.endsWith("/events")) parameters.push({ name: "after", in: "query", schema: { type: "string" } });
  if (route.path.endsWith("/history"))
    parameters.push(
      { name: "cursor", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
    );
  if (route.path.endsWith("/exports"))
    parameters.push({ name: "requestId", in: "query", required: true, schema: { type: "string", format: "uuid" } });
  if (route.path === "/v1/budget-scopes/{scopeId}/policy" && route.method === "put")
    parameters.push(
      { name: "If-Match", in: "header", schema: { type: "string" } },
      { name: "If-None-Match", in: "header", schema: { const: "*" } },
    );
  return parameters;
}

const errorName = (route: (typeof managedRoutes)[number]) => (route.shipped ? "WireError" : "Error");

function responsesFor(route: (typeof managedRoutes)[number]) {
  const media = route.response === "bytes" ? "application/octet-stream" : "application/json";
  const responses: Record<string, object> =
    route.response === "empty"
      ? {
          "204": { description: "Provisioning completed or identically replayed" },
        }
      : {
          "200": {
            description: "Lookup, completed operation or identical replay",
            content: content(route.response, route.response === "RuntimeEvent" ? "text/event-stream" : media),
          },
        };
  if (!route.shipped && route.body && ["SessionCreate", "RequestInput", "InputUpload"].includes(route.body))
    responses["201"] = { description: "Created or accepted once", content: content(route.response) };
  if (route.response === "CancelReceipt")
    responses["202"] = { description: "Cancellation pending", content: content(route.response) };
  for (const status of [400, 403, 404, 409, 410, 412, 413, 422, 429, 503])
    responses[status] = {
      description: "Safe managed error; reconcile potentially accepted writes by identity",
      content: content(errorName(route)),
    };
  return responses;
}

export function generatedManagedContract() {
  const definitions = Object.fromEntries(
    Object.entries(managedSchemas).map(([name, schema]) => [
      name,
      JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" }))),
    ]),
  );
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:pocketcoder:managed:contracts:1",
    title: MANAGED_CONTRACT_REVISION,
    description:
      "Versioned integration contract. Unimplemented operations remain marked x-shipped:false. Cross-record identity, Unicode validity, state transitions and authorization require the exported runtime validators and contract notes.",
    $defs: definitions,
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of managedRoutes) {
    const operation = {
      "x-shipped": route.shipped,
      "x-contract-revision": MANAGED_CONTRACT_REVISION,
      parameters: parametersFor(route),
      security: [{ bearerAuth: [] }],
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: content(route.body, route.body === "bytes" ? "application/octet-stream" : "application/json"),
            },
          }
        : {}),
      responses: responsesFor(route),
    };
    const methods = paths[route.path] ?? {};
    methods[route.method] = operation;
    paths[route.path] = methods;
  }
  return {
    schema,
    openapi: {
      openapi: "3.1.0",
      info: { title: "PocketCoder managed integration", version: "1" },
      paths,
      components: { schemas: definitions, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    },
  };
}
