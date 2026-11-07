import { randomUUID } from "node:crypto";
import { ApiError, canonicalJson, digestOf, InputObjectReferenceSchema, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedFileStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { readInput } from "../persistence/inputs/objects";
import { logicalExports } from "./request-collection";
import { workAuthority } from "./work-authority";

export function sessionInputNamespace(principalId: string, sessionId: string) {
  const hash = digestOf({ domain: "session-inputs/v1", principalId, sessionId }).slice(7);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function createManagedFiles(context: DatabaseContext): ManagedFileStore {
  const { db, tables } = context;
  const table = tables.sessionInputs;
  const authorize = workAuthority(context);
  const key = (principalId: string, sessionId: string, inputId: string) =>
    and(eq(table.principalId, principalId), eq(table.sessionId, sessionId), eq(table.inputId, inputId));
  async function describe(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    row: typeof table.$inferSelect,
  ): Promise<managed.InputObject> {
    const source = await readInput(context, tx, row.source.workspaceId, row.inputId);
    let state: managed.InputObject["state"] = "uploading";
    if (source?.state === "ready") state = source.retainedUntil > new Date() ? "ready" : "expired";
    else if (source?.state === "expired" && source.publishedAt) state = "expired";
    else if (source && source.state !== "uploading") state = "rejected";
    else if (row.expiresAt <= new Date()) state = "expired";
    return {
      sessionId: row.sessionId,
      reference: row.reference,
      state,
      expiresAt: (source?.retainedUntil ?? row.expiresAt).toISOString(),
    };
  }
  function requireSameInput(reference: managed.InputReference, input: managed.InputUpload) {
    const { versionId: _, ...descriptor } = reference;
    if (canonicalJson(descriptor) !== canonicalJson(input))
      throw new ApiError("idempotency.conflict", "Input identity changed.");
  }
  return {
    async register(keyId, sessionId, input, limits) {
      input = managed.InputUploadSchema.parse(input);
      if (
        !input.name.isWellFormed() ||
        !input.mediaType.isWellFormed() ||
        input.name.includes("/") ||
        input.name.includes("\\") ||
        input.name.includes(String.fromCharCode(0)) ||
        [".", ".."].includes(input.name)
      )
        throw new ApiError("attachment.invalid", "Input name must be one safe file name.");
      if (input.sizeBytes > limits.fileBytes)
        throw new ApiError("attachment.too_large", "Input exceeds its per-file limit.");
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:write");
        const [known] = await tx
          .select()
          .from(table)
          .where(key(id.principalId, sessionId, input.inputId));
        if (known) {
          requireSameInput(known.reference, input);
          return describe(tx, known);
        }
        const active = (
          await tx
            .select()
            .from(table)
            .where(and(eq(table.principalId, id.principalId), eq(table.sessionId, sessionId)))
        ).filter((row) => row.expiresAt > new Date());
        if (
          active.length >= limits.files ||
          active.reduce((n, row) => n + row.reference.sizeBytes, 0) + input.sizeBytes > limits.stagedBytes
        )
          throw new ApiError("storage.capacity_exhausted", "Session input capacity is exhausted.");
        let uploading = 0;
        for (const row of active) if ((await describe(tx, row)).state === "uploading") uploading++;
        if (uploading >= limits.transfers)
          throw new ApiError("storage.capacity_exhausted", "Session transfer capacity is exhausted.");
        const contents = {
          workspaceId: sessionInputNamespace(id.principalId, sessionId),
          fileId: input.inputId,
          name: input.name,
          mediaType: input.mediaType,
          sizeBytes: input.sizeBytes,
          digest: input.sha256,
        };
        const source = InputObjectReferenceSchema.parse({
          ...contents,
          objectVersion: digestOf(contents),
          visibility: "ready",
        });
        const row = {
          ...id,
          inputId: input.inputId,
          reference: { ...input, versionId: randomUUID() },
          source,
          expiresAt: new Date(Date.now() + limits.retentionMs),
        };
        await tx.insert(table).values(row);
        return describe(tx, row);
      });
    },
    async get(keyId, sessionId, inputId) {
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:read");
        const [row] = await tx
          .select()
          .from(table)
          .where(key(id.principalId, sessionId, inputId));
        if (!row) throw new ApiError("attachment.not_found", "Unknown session input.");
        return describe(tx, row);
      });
    },
    async upload(keyId, sessionId, inputId) {
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:write");
        const [row] = await tx
          .select()
          .from(table)
          .where(key(id.principalId, sessionId, inputId));
        if (!row) throw new ApiError("attachment.not_found", "Unknown session input.");
        return { principalId: id.principalId, reference: row.source, sessionId, expiresAt: row.expiresAt };
      });
    },
    ...logicalExports(context),
  };
}
