import { statfs } from "node:fs/promises";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";
import type { Hub } from "../control-channel/hub";
import type { Readiness } from "./health";

const Ages = z.strictObject({ count: z.number().int().nonnegative(), oldestSeconds: z.number().nonnegative() });
const Disk = z.strictObject({ totalBytes: z.number().positive(), availableBytes: z.number().nonnegative() });
export const ControllerHealthSchema = z.strictObject({
  sampledAt: z.number().positive(),
  ready: z.boolean(),
  queue: Ages,
  heartbeat: z.strictObject({ missing: z.number().int().nonnegative(), oldestSeconds: z.number().nonnegative() }),
  cleanup: Ages,
  disk: Disk,
  runtimeDisk: Disk,
  journal: z.strictObject({
    configured: z.boolean(),
    lastAcknowledgedAt: z.number().positive().nullable(),
    pendingSeconds: z.number().nonnegative().nullable(),
  }),
});

export async function diskHeadroom(directory: string) {
  const disk = await statfs(directory);
  return { totalBytes: disk.blocks * disk.bsize, availableBytes: disk.bavail * disk.bsize };
}

export async function controllerHealth(deps: {
  store: Store;
  hub: Hub;
  directory: string;
  readiness: Readiness;
  now?: Date;
}) {
  const now = deps.now ?? new Date();
  const age = (at: Date) => Math.max(0, (now.getTime() - at.getTime()) / 1000);
  const oldest = (dates: Date[]) => Math.max(0, ...dates.map(age));
  const [workspaces, operations, leases, warm, transfers, disk, runtimeDisk] = await Promise.all([
    deps.store.listNonterminal(),
    deps.store.listIncompleteOperations(),
    deps.store.listPendingWorkspaceLeases(),
    deps.store.listWarmPoolRuntimes(),
    deps.store.checkpointTransfers.listUnsettled(),
    diskHeadroom(deps.directory),
    diskHeadroom("/"),
  ]);
  const queued = workspaces.filter((row) => row.state === "queued");
  const connected = workspaces.filter((row) => ["ready", "connected"].includes(row.state));
  const heartbeats = connected.map((row) => deps.hub.get(row.id)?.lastHeartbeatAt);
  const cleanupStates = await Promise.all(
    workspaces
      .filter((row) => ["preserving", "terminating"].includes(row.state))
      .map(async (row) => {
        const history = await deps.store.listStateHistory(row.id);
        const transition = history.findLast((entry) => entry.toState === row.state);
        return transition?.occurredAt ?? row.updatedAt;
      }),
  );
  const cleanup = [
    ...cleanupStates,
    ...operations.filter((row) => ["preserve", "delete", "purge"].includes(row.kind)).map((row) => row.createdAt),
    ...leases.filter((row) => row.state === "revoking").map((row) => row.updatedAt),
    ...warm.filter((row) => row.state === "draining").map((row) => row.updatedAt),
    ...transfers.filter((row) => row.state === "cleanup_pending").map((row) => row.updatedAt),
  ];
  const journal = deps.store.journalStatus();
  return ControllerHealthSchema.parse({
    sampledAt: now.getTime() / 1000,
    ready: deps.readiness.snapshot().ok,
    queue: { count: queued.length, oldestSeconds: oldest(queued.map((row) => row.createdAt)) },
    heartbeat: {
      missing: heartbeats.filter((at) => !at).length,
      oldestSeconds: oldest(heartbeats.filter((at) => at !== undefined)),
    },
    cleanup: { count: cleanup.length, oldestSeconds: oldest(cleanup) },
    disk,
    runtimeDisk,
    journal: {
      configured: journal.configured,
      lastAcknowledgedAt: journal.lastAcknowledgedAt ? journal.lastAcknowledgedAt.getTime() / 1000 : null,
      pendingSeconds: journal.pendingSince ? age(journal.pendingSince) : null,
    },
  });
}
