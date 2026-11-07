import {
  ApiError,
  canonicalJson,
  type LifetimeExtension,
  LifetimeExtensionSchema,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";

export function extendWorkspaceDeadline(context: DatabaseContext) {
  return async (id: string, principalId: string, input: LifetimeExtension, now: () => Date = () => new Date()) => {
    const command = LifetimeExtensionSchema.parse(input);
    const table = context.tables.workspaces;
    const result = await context.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(table)
        .where(and(eq(table.id, id), eq(table.principalId, principalId)))
        .for("update");
      if (!row) throw new ApiError("workspace.not_found", "Workspace not found.");
      const at = now();
      const prior = row.lifetime?.extensions[command.extensionId];
      if (prior) return replay(prior, command);
      const lifetime = extensibleLifetime(row, at);
      if (command.expectedRevision !== lifetime.revision)
        throw new ApiError("operation.conflict", "Workspace deadline revision changed.");
      const deadlineAt = new Date(command.deadlineAt);
      if (deadlineAt <= row.deadlineAt || deadlineAt > new Date(lifetime.ceilingAt))
        throw new ApiError("validation.invalid", "Deadline exceeds the workspace lifetime ceiling.");
      if (Object.keys(lifetime.extensions).length >= 1000)
        throw new ApiError("operation.conflict", "Workspace extension limit reached.");
      const receipt = { ...command, workspaceId: id, revision: lifetime.revision + 1, ceilingAt: lifetime.ceilingAt };
      await tx
        .update(table)
        .set({
          deadlineAt,
          lifetime: {
            ...lifetime,
            revision: receipt.revision,
            extensions: { ...lifetime.extensions, [command.extensionId]: receipt },
          },
          updatedAt: at,
          changeSeq: sql`${table.changeSeq}+1`,
        })
        .where(eq(table.id, id));
      return receipt;
    });
    notifyChange(context, id);
    return result;
  };
}

function extensibleLifetime(
  row: Pick<WorkspaceRow, "lifetime" | "purgeRequestedAt" | "state" | "deadlineAt" | "templateSnapshot">,
  at: Date,
) {
  if (!row.lifetime || row.purgeRequestedAt || !["ready", "connected"].includes(row.state) || row.deadlineAt <= at)
    throw new ApiError("operation.conflict", "Workspace lifetime cannot be extended.");
  if (row.templateSnapshot.spec.network.mode === "restricted")
    throw new ApiError("operation.conflict", "Workspace egress audit authority cannot be extended.");
  return row.lifetime;
}

function replay(prior: import("@pstdio/pocketcoder-contracts").LifetimeReceipt, command: LifetimeExtension) {
  const { workspaceId: _, revision: _revision, ceilingAt: _ceiling, ...accepted } = prior;
  if (canonicalJson(accepted) !== canonicalJson(command))
    throw new ApiError("operation.conflict", "Lifetime extension identity conflicts.");
  return prior;
}
