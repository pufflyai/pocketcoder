import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedQueueLimits, Store } from "@pstdio/pocketcoder-runtime-core";
import { dispositionFilename } from "../attachments/attachments";
import type { InputStorage, InputStorageOptions } from "../attachments/input-storage";
import { MANAGED_ERROR_RESPONSES, managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

const sessionParams = z.object({ sessionId: z.uuid() });
const requestParams = sessionParams.extend({ requestId: z.uuid() });
const inputParams = sessionParams.extend({ inputId: z.uuid() });
const response = <T extends z.ZodType>(schema: T, description: string) => ({
  200: { description, content: { "application/json": { schema } } },
  ...MANAGED_ERROR_RESPONSES,
});
export function registerSessionWorkRoutes(
  app: OpenAPIHono<AppEnv>,
  store: Store,
  options: { inputs?: InputStorage; storage?: InputStorageOptions; queue?: ManagedQueueLimits },
) {
  const base = "/v1/sessions/{sessionId}";
  app.use("/v1/sessions/:sessionId/requests", managedBodyLimit(1048576));
  app.use("/v1/sessions/:sessionId/inputs", managedBodyLimit(16384));
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/requests`,
      tags: ["Managed sessions"],
      operationId: "submitManagedRequest",
      middleware: [requireScope("sessions:write")] as const,
      request: {
        params: sessionParams,
        body: { content: { "application/json": { schema: managed.RequestInputSchema } } },
      },
      responses: response(managed.RequestSchema, "Accepted or identically replayed request"),
    }),
    async (c) => {
      const result = await store.managed.requests.accept(
        c.get("keyId"),
        c.req.valid("param").sessionId,
        c.req.valid("json"),
        options.queue ?? { count: 8, bytes: 8388608 },
      );
      return c.json(result.request, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/requests/{requestId}`,
      tags: ["Managed sessions"],
      operationId: "getManagedRequest",
      middleware: [requireScope("sessions:read")] as const,
      request: { params: requestParams },
      responses: response(managed.RequestSchema, "Durable logical request"),
    }),
    async (c) => {
      const { sessionId, requestId } = c.req.valid("param");
      return c.json(await store.managed.requests.get(c.get("keyId"), sessionId, requestId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/requests/{requestId}/collection`,
      tags: ["Managed sessions"],
      operationId: "getManagedCollection",
      middleware: [requireScope("sessions:read")] as const,
      request: { params: requestParams },
      responses: response(managed.CollectionResultSchema, "Collection including pending and empty results"),
    }),
    async (c) => {
      const { sessionId, requestId } = c.req.valid("param");
      return c.json((await store.managed.requests.get(c.get("keyId"), sessionId, requestId)).collection, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: `${base}/inputs/{inputId}`,
      tags: ["Managed sessions"],
      operationId: "uploadManagedInput",
      middleware: [requireScope("sessions:write")] as const,
      request: { params: inputParams, body: { content: { "application/octet-stream": { schema: z.any() } } } },
      responses: response(managed.InputObjectSchema, "Verified immutable input, or identical replay"),
    }),
    async (c) => {
      if (!options.inputs || !options.storage)
        throw new ApiError("attachment.unsupported", "Immutable input storage is not configured.");
      const { sessionId, inputId } = c.req.valid("param");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of c.req.raw.body ?? []) {
        size += chunk.byteLength;
        if (size > options.storage.limits.fileBytes)
          throw new ApiError("attachment.too_large", "Input exceeds its per-file limit.");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const descriptor = managed.InputUploadSchema.safeParse({
        inputId,
        name:
          dispositionFilename(c.req.header("content-disposition") ?? "") ??
          c.req.header("x-pocketcoder-file-name") ??
          "attachment",
        mediaType: c.req.header("content-type") ?? "application/octet-stream",
        sizeBytes: size,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      });
      if (!descriptor.success) throw new ApiError("attachment.invalid", "Invalid file name or media type.");
      const object = await store.managed.files.register(
        c.get("keyId"),
        sessionId,
        descriptor.data,
        options.storage.limits,
      );
      if (object.state === "ready") return c.json(object, 200);
      const upload = await store.managed.files.upload(c.get("keyId"), sessionId, inputId);
      await options.inputs.upload(
        upload.principalId,
        upload.reference,
        upload.expiresAt,
        new Response(bytes).body,
        c.req.raw.signal,
        sessionId,
      );
      return c.json(await store.managed.files.get(c.get("keyId"), sessionId, inputId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/inputs/{inputId}`,
      tags: ["Managed sessions"],
      operationId: "getManagedInput",
      middleware: [requireScope("sessions:read")] as const,
      request: { params: inputParams },
      responses: response(managed.InputObjectSchema, "Input readiness"),
    }),
    async (c) => {
      const { sessionId, inputId } = c.req.valid("param");
      return c.json(await store.managed.files.get(c.get("keyId"), sessionId, inputId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/exports`,
      tags: ["Managed sessions"],
      operationId: "listManagedExports",
      middleware: [requireScope("sessions:read")] as const,
      request: { params: sessionParams, query: z.object({ requestId: z.uuid() }) },
      responses: response(managed.ManagedExportPageSchema, "Retained request exports"),
    }),
    async (c) =>
      c.json(
        {
          items: await store.managed.files.exports(
            c.get("keyId"),
            c.req.valid("param").sessionId,
            c.req.valid("query").requestId,
          ),
          nextCursor: null,
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/exports/{exportId}/content`,
      tags: ["Managed sessions"],
      operationId: "downloadManagedExport",
      middleware: [requireScope("sessions:read")] as const,
      request: { params: sessionParams.extend({ exportId: z.uuid() }) },
      responses: {
        200: { description: "Retained immutable bytes", content: { "application/octet-stream": { schema: z.any() } } },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { sessionId, exportId } = c.req.valid("param");
      const bytes = await store.managed.files.content(c.get("keyId"), sessionId, exportId);
      return new Response(Buffer.from(bytes), {
        headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store" },
      });
    },
  );
}
