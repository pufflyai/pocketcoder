import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import {
  type OffNode,
  OffNodeBackupReceiptSchema,
  type RuntimeIdentity,
  readPrivateFile,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { requireRuntimeTermination, runtimeRow } from "../backup/runtime-proof";

const Marker = z.strictObject({
  operationId: z.uuid(),
  snapshotId: z.uuid(),
  sourceWriter: SourceWriterSchema,
  receipt: OffNodeBackupReceiptSchema,
});
export function createOffNodeRecovery(store: PGliteStore, offNode: OffNode, directory: string) {
  async function marker() {
    return Marker.parse(
      JSON.parse((await readPrivateFile(join(directory, "off-node-restore.json"), 65_536)).toString()),
    );
  }
  return {
    async handoff(
      operationId: string,
      snapshotId: string,
      identity: RuntimeIdentity,
      termination: Record<string, unknown>,
    ) {
      const binding = await marker();
      if (
        binding.operationId !== operationId ||
        binding.snapshotId !== snapshotId ||
        !binding.receipt.runtimes.some((runtime) => isDeepStrictEqual(runtime, identity))
      )
        throw new Error("Runtime handoff snapshot identity differs.");
      if (!(await store.recovery.recoveryState())) throw new Error("Runtime handoff requires private recovery.");
      const row = await runtimeRow(store, identity);
      requireRuntimeTermination(identity, termination);
      const patch = { providerRef: { ...row.providerRef, terminationEvidence: termination } };
      if (identity.kind === "workspace") await store.updateWorkspace(identity.id, patch, new Date());
      else await store.updateWarmPoolRuntime(identity.id, patch, new Date());
      return { accepted: true };
    },
    async status() {
      const identity = await marker();
      const recovery = await store.recovery.recoveryState();
      if (recovery && recovery.snapshotId !== identity.snapshotId)
        throw new Error("Recovery snapshot identity differs.");
      if (!recovery) await store.acknowledgeJournal();
      const snapshot = store.journalSnapshot();
      return {
        operation_id: identity.operationId,
        snapshot_id: identity.snapshotId,
        complete: !recovery,
        writer: snapshot.writer,
        current_journal: snapshot.head,
      };
    },
    async claim(operationId: string) {
      const identity = await marker();
      if (identity.operationId !== operationId) throw new Error("Restore operation identity differs.");
      for (const runtime of identity.receipt.runtimes) {
        const row = await runtimeRow(store, runtime);
        const termination = row.providerRef?.terminationEvidence as Record<string, unknown> | undefined;
        if (!termination) throw new Error("Archived runtime handoff is missing.");
        requireRuntimeTermination(runtime, termination);
      }
      // Only the manager's private path enters here, after retaining source compute-death proof.
      await offNode.journal.transfer(store.journalSnapshot(), identity.sourceWriter);
      await store.acknowledgeJournal();
      return this.status();
    },
  };
}
export type OffNodeRecovery = ReturnType<typeof createOffNodeRecovery>;
