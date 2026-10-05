import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DatabaseContext, Transaction } from "../../database/context";

export function createLockedWorkspaceQuery({ db, tables: { workspaces } }: DatabaseContext) {
  const query = db
    .select({
      id: workspaces.id,
      state: workspaces.state,
      purgeRequestedAt: workspaces.purgeRequestedAt,
      externalId: workspaces.externalId,
      reasonCode: workspaces.reasonCode,
      agentState: workspaces.agentState,
      provisioningMode: workspaces.provisioningMode,
      changeSeq: workspaces.changeSeq,
      failureLogTail: workspaces.failureLogTail,
      failureLogTailTruncated: workspaces.failureLogTailTruncated,
      failureLastLogSeq: workspaces.failureLastLogSeq,
      templateName: workspaces.templateName,
      templateVersion: workspaces.templateVersion,
      templateDigest: workspaces.templateDigest,
      originWorkspaceId: workspaces.originWorkspaceId,
      restoredFromCheckpointId: workspaces.restoredFromCheckpointId,
      latestCheckpointId: workspaces.latestCheckpointId,
      outputs: workspaces.outputs,
    })
    .from(workspaces)
    .where(eq(workspaces.id, sql.placeholder("workspaceId")))
    .for("update");
  type Rows = Awaited<ReturnType<typeof query.execute>>;
  const compiled = query.toSQL();
  const fields = query._.config.fieldsFlat;
  if (!fields) throw new Error("locked workspace query has no compiled fields");
  const mapper = new PgDialect({ useJitMappers: false }).mapperGenerators.rows<Rows[number]>(fields, {});
  // Cache the SQL and decoders; each read still uses the current transaction and row lock.
  return (tx: Transaction, workspaceId: string) =>
    tx._.session.prepareQuery<{ execute: Rows }>(compiled, "arrays", false, mapper).execute({ workspaceId });
}
