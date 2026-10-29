import {
  AgentMessageRequestSchema,
  ApiError,
  AttachmentMediaTypeSchema,
  isTerminal,
} from "@pstdio/pocketcoder-contracts";
import type { Context } from "hono";
import type { AppEnv } from "../http/middleware";
import type { RelayDeps } from "../relay/relay";
import { inputReference } from "./input-storage";

export function dispositionFilename(header: string): string | null {
  const extended = header.match(/filename\*=(?:utf-8|UTF-8)''([^;]+)/);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return null;
    }
  }
  const quoted = header.match(/filename="((?:[^"\\]|\\.)*)"/);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = header.match(/filename=([^";\s]+)/);
  return bare?.[1] ?? null;
}

export function attachmentUploadHandler(deps: RelayDeps) {
  return async (c: Context<AppEnv>) => {
    const principal = c.get("principal");
    const id = c.req.param("id") ?? "";
    const fileId = (c.req.param("attachmentId") ?? "").toLowerCase();
    const row = await deps.service.getOwned(principal, id);
    if (row.purgeRequestedAt) throw new ApiError("operation.conflict", "Workspace content is being purged.");
    if (isTerminal(row.state)) throw new ApiError("workspace.terminal", "This workspace has ended.");
    if (row.state !== "ready") throw new ApiError("workspace.not_ready", "Workspace is not ready.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fileId))
      throw new ApiError("attachment.invalid", "The attachment ID must be a UUID.");
    const { name, mediaType, size, sha256 } = uploadHeaders(c);
    if (!deps.inputs) throw new ApiError("attachment.unsupported", "Trusted input storage is not configured.");
    const reference = inputReference(id, fileId, name, mediaType, size, `sha256:${sha256}`);
    const result = await deps.inputs.upload(principal.id, reference, row.deadlineAt, c.req.raw.body, c.req.raw.signal);
    await deps.store.updateWorkspace(id, { lastActivityAt: new Date() }, new Date());
    return c.json(result.reference, result.created ? 201 : 200);
  };
}

export function agentMessageBodyTransform(_deps: RelayDeps) {
  return async (_c: Context<AppEnv>, bodyB64: string | undefined) => {
    if (!bodyB64) return bodyB64;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(bodyB64, "base64").toString("utf8"));
    } catch {
      return bodyB64;
    }
    if (typeof json !== "object" || json === null || (json as Record<string, unknown>).attachment_ids === undefined)
      return bodyB64;
    const parsed = AgentMessageRequestSchema.safeParse(json);
    if (!parsed.success) throw new ApiError("attachment.invalid", "attachment_ids must be unique UUIDs.");
    throw new ApiError(
      "attachment.unsupported",
      "Attachment dispatch requires a qualified immutable-input projection driver.",
    );
  };
}

function uploadHeaders(c: Context<AppEnv>) {
  const name = dispositionFilename(c.req.header("content-disposition") ?? "");
  const mediaType = c.req.header("content-type") ?? "application/octet-stream";
  const rawSize = c.req.header("content-length") ?? "";
  const size = Number(rawSize);
  const sha256 = c.req.header("x-content-sha256") ?? "";
  if (
    !name ||
    !AttachmentMediaTypeSchema.safeParse(mediaType).success ||
    !/^\d+$/.test(rawSize) ||
    !Number.isSafeInteger(size) ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    throw new ApiError(
      "attachment.invalid",
      "Filename, media type, exact Content-Length and X-Content-SHA256 are required.",
    );
  if (name.length > 255) throw new ApiError("attachment.invalid", "Input names may contain at most 255 characters.");
  return { name, mediaType, size, sha256 };
}
