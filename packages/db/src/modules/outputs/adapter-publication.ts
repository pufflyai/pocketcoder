import {
  ApiError,
  canonicalJson,
  digestOf,
  managed,
  sha256Hex,
  type WorkloadExportReference,
} from "@pstdio/pocketcoder-contracts";
import type { RetainedExportStore, StorageCapacity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { lockExecutionSession, readExecution, writeExecution } from "../workspaces/execution-owners";
import { reserveExport } from "./retained-export-capacity";

type Publication = Parameters<RetainedExportStore["publish"]>[2][number];

function publicationObjectId(execution: WorkloadExportReference["execution"], publicationId: string) {
  const hash = digestOf({ domain: "adapter-publication/v1", execution, publicationId }).slice(7);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function adapterPublication(
  context: DatabaseContext,
  commit: RetainedExportStore["commit"],
): Pick<RetainedExportStore, "publish" | "seal"> {
  const { db, tables } = context;
  const objects = tables.exportObjects;
  async function publicationOwner(
    tx: Transaction,
    execution: WorkloadExportReference["execution"],
    fingerprint: string,
  ) {
    const [workspace] = await tx
      .select()
      .from(tables.workspaces)
      .where(eq(tables.workspaces.id, execution.workspaceId))
      .for("update");
    if (
      !workspace ||
      workspace.purgeRequestedAt ||
      workspace.runtimeRegistration?.endedAt ||
      workspace.runtimeRegistration?.incarnationId !== execution.incarnationId
    )
      throw new ApiError("operation.conflict", "Publication runtime is unavailable.");
    const record = await readExecution(context, tx, workspace, execution);
    if (!record || !record.dispatchClaimedAt || record.acceptance.fingerprint !== fingerprint)
      throw new ApiError("operation.conflict", "Publication execution does not match.");
    const spec = workspace.runtimeRegistration.template?.manifest.spec;
    const operation = spec?.operations[record.acceptance.operation];
    const adapter = operation && workspace.runtimeRegistration.producer?.adapters[operation.adapter];
    if (!spec || !operation?.outputRoots.length || !adapter?.capabilities.includes("explicit-publication"))
      throw new ApiError("operation.conflict", "Explicit result publication is not supported.");
    const existing = (await tx.select().from(objects).where(eq(objects.workspaceId, workspace.id))).filter(
      (row) => canonicalJson(row.execution) === canonicalJson(execution),
    );
    const owner =
      execution.owner === "conversation-request"
        ? (await tx.select().from(tables.conversationRequests)).find(
            (row) => row.managed && canonicalJson(row.execution?.acceptance.execution) === canonicalJson(execution),
          )
        : null;
    return { workspace, record, spec, existing, owner };
  }
  function publicationReference(execution: WorkloadExportReference["execution"], publication: Publication) {
    if (
      !publication.name.isWellFormed() ||
      publication.name.startsWith("/") ||
      publication.name.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      publication.name.includes("\\") ||
      publication.name.includes(String.fromCharCode(0)) ||
      publication.sizeBytes !== publication.bytes.length ||
      publication.digest !== `sha256:${sha256Hex(publication.bytes)}`
    )
      throw new ApiError("operation.conflict", "Publication content does not match its descriptor.");
    const objectId = publicationObjectId(execution, publication.publicationId);
    const reference = {
      objectId,
      objectVersion: publication.digest,
      digest: publication.digest,
      name: publication.name,
      mediaType: publication.mediaType,
      sizeBytes: publication.sizeBytes,
    };
    return reference;
  }
  async function stagePublication(
    tx: Transaction,
    scope: Awaited<ReturnType<typeof publicationOwner>>,
    publication: Publication,
    at: Date,
    capacity: StorageCapacity | undefined,
  ) {
    const { workspace, record, spec, existing, owner } = scope;
    const execution = record.acceptance.execution;
    const reference = publicationReference(execution, publication);
    const objectId = reference.objectId;
    const known = existing.find((row) => row.id === reference.objectId);
    if (known) {
      if (
        canonicalJson(known.reference) !== canonicalJson(reference) ||
        (known.data !== null && !Buffer.from(known.data).equals(publication.bytes))
      )
        throw new ApiError("idempotency.conflict", "Publication identity changed.");
      return;
    }
    if (
      record.collection ||
      record.publicationComplete ||
      !["accepted", "dispatching", "running"].includes(record.phase)
    )
      throw new ApiError("operation.conflict", "Publication is already sealed.");
    const count = existing.length + 1;
    const bytes = existing.reduce((n, row) => n + row.reference.sizeBytes, 0) + publication.bytes.length;
    const maxObjects = owner
      ? Math.min(spec.limits.exportFiles, managed.MAX_SESSION_FILE_REFERENCES)
      : spec.limits.exportFiles;
    if (count > maxObjects || bytes > spec.limits.exportBytes)
      throw new ApiError("operation.conflict", "Publication exceeds its declared limits.");
    const core = { execution, objects: [reference], completeness: "complete" as const, errors: [] };
    const expiresAt = new Date(at.getTime() + spec.limits.exportRetentionSeconds * 1000).toISOString();
    const staging: WorkloadExportReference = {
      ...core,
      exportId: objectId,
      manifestDigest: digestOf(core),
      publication: "published",
      publishedAt: at.toISOString(),
      expiresAt,
    };
    await reserveExport(context, tx, staging, workspace.principalId, at, capacity);
    const inserted = {
      id: objectId,
      exportId: objectId,
      reservationId: objectId,
      sessionId: owner?.conversationId ?? null,
      workspaceId: workspace.id,
      principalId: workspace.principalId,
      execution,
      reference,
      data: Buffer.from(publication.bytes),
      expiresAt: new Date(expiresAt),
      deletedAt: null,
    };
    await tx.insert(objects).values(inserted);
    existing.push(inserted);
  }
  return {
    async publish(execution, fingerprint, publications, complete, at, capacity) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        await lockExecutionSession(context, tx, execution);
        const scope = await publicationOwner(tx, execution, fingerprint);
        for (const publication of publications) await stagePublication(tx, scope, publication, at, capacity);
        if (complete && !scope.record.publicationComplete)
          await writeExecution(context, tx, { ...scope.record, publicationComplete: true });
      });
    },
    async seal(execution, at) {
      const [workspace] = await db
        .select()
        .from(tables.workspaces)
        .where(eq(tables.workspaces.id, execution.workspaceId));
      if (!workspace) throw new ApiError("workspace.not_found", "Publication owner is unavailable.");
      const record = await readExecution(context, db, workspace, execution);
      if (!record) throw new ApiError("operation.conflict", "Publication execution is unavailable.");
      if (record.collection) return record.collection;
      const spec = workspace.runtimeRegistration?.template?.manifest.spec;
      if (!spec) throw new ApiError("operation.conflict", "Publication limits are unavailable.");
      const staged = (await db.select().from(objects).where(eq(objects.workspaceId, execution.workspaceId)))
        .filter((row) => canonicalJson(row.execution) === canonicalJson(execution))
        .sort((a, b) => a.id.localeCompare(b.id));
      const complete = record.publicationComplete || !spec.operations[record.acceptance.operation]?.outputRoots.length;
      let completeness: WorkloadExportReference["completeness"] = "lost";
      if (staged.length) completeness = "partial";
      if (complete) completeness = "complete";
      const core = {
        execution,
        objects: staged.map((row) => row.reference),
        completeness,
        errors: complete ? [] : ["publication_incomplete"],
      };
      const manifest: WorkloadExportReference = {
        ...core,
        exportId: publicationObjectId(execution, "manifest"),
        manifestDigest: digestOf(core),
        publication: "published",
        publishedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + spec.limits.exportRetentionSeconds * 1000).toISOString(),
        cleanupState: "complete",
      };
      return commit(
        manifest,
        staged.map((row) => ({ objectId: row.id, bytes: row.data ?? new Uint8Array() })),
        at,
      );
    },
  };
}
