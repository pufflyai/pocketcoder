import { ApiError } from "@pstdio/pocketcoder-contracts";
import {
  cleanupWarmProvider,
  type Store,
  type WorkspaceDriver,
  type WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";
import { completedDrainInventory, retainDrainInventory } from "./account-compute-proof";
import type { accountState } from "./account-state";
import type { Maintenance } from "./maintenance";

type Action = "suspend" | "resume";
const states = {
  suspend: { from: "ready", pending: "suspending", done: "suspended" },
  resume: { from: "suspended", pending: "resuming", done: "ready" },
} as const;
export function createAccountLifecycle(deps: {
  state: Awaited<ReturnType<typeof accountState>>;
  maintenance: Maintenance;
  store: Store;
  driver: WorkspaceDriver;
  storageDriver?: WorkspaceStorageDriver;
  runtime: Pick<BuiltServer, "scheduler" | "persistence" | "workspaceLeases" | "checkpointTransfers">;
  reconcileData: () => Promise<void>;
}) {
  const { state, maintenance, store, driver, runtime } = deps;
  if (state.state.state !== "ready") maintenance.fence();
  let running: { id: string; kind: Action; promise: Promise<ReturnType<typeof result>> } | undefined;
  const result = () => ({
    state: state.state.state,
    operation_state: state.state.current ? "pending" : "succeeded",
    ...(state.state.compute ? { compute_proof: state.state.compute } : {}),
  });
  const conflict = () => new ApiError("operation.conflict", "Another account lifecycle operation is pending.");

  async function revokeLeases() {
    const pending = new Set((await store.listPendingWorkspaceLeases()).map((lease) => lease.workspaceId));
    for (const workspaceId of pending) {
      if (!runtime.workspaceLeases) throw new Error("Workspace issuer is unavailable");
      await runtime.workspaceLeases.revokeWorkspace(workspaceId);
    }
    if ((await store.listPendingWorkspaceLeases()).length) throw new Error("Workspace lease cleanup is pending");
  }

  async function zeroCompute() {
    if ((await store.listNonterminal()).length) throw new Error("Workspace cleanup is pending");
    if ((await store.listWarmPoolRuntimes()).some((row) => row.state !== "failed"))
      throw new Error("Warm runtime cleanup is pending");
    // Successful discovery is required even if the database says all work ended.
    if ((await driver.list()).length || (await driver.listWarm()).length) throw new Error("Runtime cleanup is pending");
  }

  async function drainWarm() {
    for (const row of await store.listWarmPoolRuntimes()) {
      if (row.state === "failed") continue;
      await store.updateWarmPoolRuntime(
        row.id,
        { state: "draining", enrollmentDigest: null, enrollmentExpiresAt: null },
        new Date(),
      );
      await cleanupWarmProvider(store, driver, row, new Date());
      await driver.cleanupWarmInput?.(row.id);
      await store.updateWarmPoolRuntime(row.id, { state: "failed", failureCode: "account_suspended" }, new Date());
    }
  }

  async function suspend(id: string) {
    await maintenance.drain();
    await retainDrainInventory(state, store);
    const principals = new Map((await store.listPrincipals()).map((row) => [row.id, row]));
    for (const row of await store.listNonterminal()) {
      if (row.state === "preserving") continue;
      if (row.state === "terminating") {
        await runtime.scheduler.finalize(row, row.terminalIntent ?? "canceled", row.reasonCode, new Date());
        continue;
      }
      const supported =
        ["connected", "ready"].includes(row.state) && row.templateSnapshot.spec.persistence.mounts.length > 0;
      if (supported) {
        const principal = principals.get(row.principalId);
        if (!principal) throw new Error("Workspace owner is missing");
        await runtime.persistence.preserve(
          principal,
          row.id,
          { label: "account suspend" },
          `account-suspend:${id}:${row.id}`,
        );
      } else {
        await runtime.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
      }
    }
    await runtime.persistence.retryPreserves();
    await runtime.persistence.drain();
    await runtime.scheduler.drain();
    await drainWarm();
    await revokeLeases();
    await zeroCompute();
  }

  async function resume() {
    await maintenance.drain();
    await deps.reconcileData();
    await revokeLeases();
    await zeroCompute();
    for (const principal of await store.listPrincipals()) {
      for (const checkpoint of await store.listCheckpoints(principal.id, { state: "ready" })) {
        if (checkpoint.providerKind === "controller-archive" && runtime.checkpointTransfers) {
          await runtime.checkpointTransfers.verify(checkpoint);
        } else {
          if (!deps.storageDriver || !checkpoint.providerRef || !checkpoint.manifest)
            throw new Error("Checkpoint verification is unavailable");
          await deps.storageDriver.verifyCheckpoint(
            checkpoint.providerRef as { kind: string; id: string },
            checkpoint.manifest,
          );
        }
      }
    }
  }

  function validateCurrent(id: string, kind: Action) {
    const current = state.state.current;
    if (!current || current.id !== id || current.kind !== kind) throw conflict();
  }

  async function begin(id: string, kind: Action) {
    const prior = state.state.completed.find((operation) => operation.id === id);
    if (prior) {
      if (prior.kind !== kind) throw conflict();
      return false;
    }
    if (state.state.current) {
      validateCurrent(id, kind);
      return true;
    }
    if (maintenance.active && !maintenance.fenced) throw conflict();
    if (state.state.state !== states[kind].from) throw conflict();
    maintenance.fence();
    await state.save({ ...state.state, state: states[kind].pending, current: { id, kind } });
    return true;
  }

  async function run(id: string, kind: Action) {
    if (!(await begin(id, kind))) return { ...result(), operation_state: "succeeded" };
    if (kind === "suspend") await suspend(id);
    else await resume();
    await store.acknowledgeJournal?.();
    const compute = kind === "suspend" ? await completedDrainInventory(state.state.compute, store) : undefined;
    await state.save({
      state: states[kind].done,
      current: null,
      completed: [...state.state.completed, { id, kind }],
      ...(compute ? { compute } : {}),
    });
    if (kind === "resume") maintenance.release();
    return result();
  }
  return {
    status: () => ({ ...result(), admitted_requests: maintenance.admittedRequests }),
    perform(id: string, kind: Action) {
      if (running) {
        if (running.id !== id || running.kind !== kind) return Promise.reject(conflict());
        return running.promise;
      }
      const promise = run(id, kind).finally(() => {
        running = undefined;
      });
      running = { id, kind, promise };
      return promise;
    },
    async drain() {
      await running?.promise.catch(() => {});
    },
  };
}
export type AccountLifecycle = ReturnType<typeof createAccountLifecycle>;
