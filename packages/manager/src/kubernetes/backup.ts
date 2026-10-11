import { isDeepStrictEqual } from "node:util";
import {
  BackupRuntimeProofSchema,
  type OffNodeBackupReceipt,
  OffNodeBackupReceiptSchema,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import type { ManagerBackupConfig } from "../backup/config";
import { RestorationStatus, RestoreResult } from "../backup/restore-state";
import type { Account, ManagerStore } from "../database/store";
import type { kube } from "./command";
import { accountController } from "./controller";
import { privateControllerRequest } from "./private-controller";
import { restoreVolume } from "./restore-volume";
import { proveSourceStopped } from "./source-compute";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
const Placement = z.object({ name: z.string(), uid: z.string(), providerID: z.string() });

export function kubernetesBackup(command: typeof kube, config?: ManagerBackupConfig) {
  function configured(account: Account) {
    if (!account.plan.offNodeBackups || !config) throw new Error("Off-node backups are not configured.");
  }
  async function placement(operation: Operation) {
    const expected = Placement.parse(operation.computeProof?.restorePlacement);
    const node = JSON.parse(await command(["get", "node", expected.name, "-o", "json"]));
    if (node.metadata.uid !== expected.uid || node.spec.providerID !== expected.providerID)
      throw new Error("Restored volume placement identity differs.");
    return expected.name;
  }
  async function status(account: Account, operation: Operation, receipt: OffNodeBackupReceipt) {
    const result = RestoreResult.parse(operation.computeProof?.restoreResult);
    const response = RestorationStatus.parse(
      await privateControllerRequest(command, account, "/v1/backup/restoration"),
    );
    if (
      response.operation_id !== operation.id ||
      response.snapshot_id !== receipt.snapshotId ||
      !isDeepStrictEqual(response.writer, result.writer)
    )
      throw new Error("Private restored controller identity differs.");
    return response;
  }
  async function recover(account: Account, operation: Operation, receipt: OffNodeBackupReceipt) {
    configured(account);
    const nodeName = await placement(operation);
    const deployment = accountController(account, nodeName).find((resource) => resource.kind === "Deployment");
    if (!deployment) throw new Error("Restored controller deployment is missing.");
    await command(
      ["apply", "--server-side", "--field-manager=pocketcoder-manager", "-f", "-"],
      JSON.stringify(deployment),
    );
    // Recovery has a private socket, but deliberately fails the public readiness probe.
    const current = await status(account, operation, receipt);
    if (current.complete) return;
    const source = operation.computeProof?.sourceCompute as { backups?: Record<string, unknown> } | undefined;
    const proof = BackupRuntimeProofSchema.parse(source?.backups?.[receipt.operationId]);
    if (
      proof.accountId !== receipt.accountId ||
      proof.operationId !== receipt.operationId ||
      proof.snapshotId !== receipt.snapshotId ||
      proof.plaintextDigest !== receipt.plaintextDigest ||
      !isDeepStrictEqual(proof.sourceWriter, receipt.sourceWriter) ||
      !isDeepStrictEqual(
        proof.runtimes.map((runtime) => runtime.identity),
        receipt.runtimes,
      )
    )
      throw new Error("Archived runtime snapshot proof differs.");
    for (const runtime of proof.runtimes)
      await privateControllerRequest(command, account, "/v1/recovery/runtime", {
        operation_id: operation.id,
        snapshot_id: receipt.snapshotId,
        ...runtime,
      });
    await privateControllerRequest(command, account, "/v1/recovery/claim", { operation_id: operation.id });
    await privateControllerRequest(command, account, "/v1/recovery/complete", {});
    if (!(await status(account, operation, receipt)).complete) throw new Error("Controller recovery remains pending.");
  }
  async function open(account: Account, operation: Operation, receipt: OffNodeBackupReceipt) {
    configured(account);
    await placement(operation);
    if (!(await status(account, operation, receipt)).complete) throw new Error("Controller recovery remains pending.");
    // A stable annotation causes one restart even if the manager retries after the patch.
    await command([
      "-n",
      account.namespace,
      "patch",
      "deployment",
      "controller",
      "--type=merge",
      "-p",
      JSON.stringify({
        spec: { template: { metadata: { annotations: { "pocketcoder.dev/recovery-operation": operation.id } } } },
      }),
    ]);
    await command(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    if (!(await status(account, operation, receipt)).complete) throw new Error("Controller recovery remains pending.");
  }
  return {
    async runtimeProof(account: Account, receipt: OffNodeBackupReceipt) {
      configured(account);
      const proof = BackupRuntimeProofSchema.parse(
        await privateControllerRequest(command, account, "/v1/backup/runtime-proof", {
          operation_id: receipt.operationId,
        }),
      );
      if (
        proof.accountId !== account.id ||
        proof.operationId !== receipt.operationId ||
        proof.snapshotId !== receipt.snapshotId ||
        proof.plaintextDigest !== receipt.plaintextDigest ||
        !isDeepStrictEqual(proof.sourceWriter, receipt.sourceWriter) ||
        !isDeepStrictEqual(
          proof.runtimes.map((runtime) => runtime.identity),
          receipt.runtimes,
        )
      )
        throw new Error("Archived runtime source proof differs.");
      return proof;
    },
    restoreVolume: restoreVolume(command),
    proveSourceStopped: (account: Account, proof: Record<string, unknown>, restoreId?: string) =>
      proveSourceStopped(command, account, proof, restoreId),
    recover,
    open,
    async capture(account: Account, operationId: string) {
      configured(account);
      const receipt = OffNodeBackupReceiptSchema.parse(
        await privateControllerRequest(command, account, "/v1/backup/off-node", { operation_id: operationId }),
      );
      if (receipt.accountId !== account.id || receipt.operationId !== operationId)
        throw new Error("Private backup identity differs.");
      return receipt;
    },
  };
}
