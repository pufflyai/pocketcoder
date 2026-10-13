import { type ControllerHealthSchema, diskHeadroom } from "@pstdio/pocketcoder-server/monitoring";
import type { z } from "zod";
import type { Account, ManagerStore } from "../database/store";
import { accountMetrics } from "./account-metrics";
import { type ManagerBackupObservation, type ManagerBackupSample, managerBackupMetrics } from "./backup-schedule";
import type { cellCapacity } from "./cell";
import { prometheus } from "./prometheus";

async function observe<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch {
    return null;
  }
}

export function managerMonitoring(
  store: ManagerStore,
  probes: {
    directory?: string;
    account?: (account: Account) => Promise<z.infer<typeof ControllerHealthSchema>>;
    cell?: () => Promise<ReturnType<typeof cellCapacity>>;
    backup?: () => Promise<ManagerBackupObservation>;
  } = {},
) {
  const observations = new Map<string, z.infer<typeof ControllerHealthSchema> | null>();
  let cell: { at: number; value: ReturnType<typeof cellCapacity> } | null = null;
  let backup: ManagerBackupSample | null = null;
  let running: Promise<void> | undefined;
  let stopping = false;
  async function sampleBackup() {
    if (!probes.backup) return;
    const value = await observe(probes.backup);
    backup = value ? { at: Date.now() / 1000, value } : null;
  }
  async function sampleAccounts(accounts: Account[]) {
    const read = probes.account;
    const ready = accounts.filter((account) => account.state === "ready");
    for (const account of accounts) if (account.state !== "ready") observations.delete(account.id);
    if (!read) return;
    for (let index = 0; index < ready.length; index += 4) {
      if (stopping) break;
      await Promise.all(
        ready.slice(index, index + 4).map(async (account) => {
          observations.set(account.id, await observe(() => read(account)));
        }),
      );
    }
  }
  return {
    sample() {
      if (stopping) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        const accounts = await store.listAccounts();
        const ids = new Set(accounts.map((account) => account.id));
        for (const id of observations.keys()) if (!ids.has(id)) observations.delete(id);
        if (probes.cell) {
          const value = await observe(probes.cell);
          cell = value ? { at: Date.now() / 1000, value } : null;
        }
        await sampleBackup();
        await sampleAccounts(accounts);
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    async metrics() {
      const now = Date.now() / 1000;
      const [accounts, operations] = await Promise.all([store.listAccounts(), store.pendingOperations()]);
      const output = prometheus();
      output.add("manager_pending_operations", operations.length);
      output.add(
        "manager_pending_oldest_seconds",
        Math.max(0, ...operations.map((operation) => Math.max(0, now - operation.createdAt.getTime() / 1000))),
      );
      output.add("cell_observed", cell ? 1 : 0);
      output.add("cell_observation_age_seconds", cell ? Math.max(0, now - cell.at) : null);
      managerBackupMetrics(output, Boolean(probes.backup), backup, now);
      if (cell)
        for (const [name, value] of Object.entries(cell.value))
          output.add(`cell_${name.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`)}`, value);
      for (const account of accounts) {
        const backups = await store.listBackups(account.id);
        const latest = backups.reduce<number | null>(
          (at, backup) => Math.max(at ?? 0, Date.parse(backup.receipt.createdAt)),
          null,
        );
        accountMetrics(
          output,
          account,
          observations.get(account.id),
          latest === null ? undefined : new Date(latest),
          now,
        );
      }
      if (probes.directory) {
        const disk = await diskHeadroom(probes.directory);
        output.add("manager_disk_available_bytes", disk.availableBytes);
        output.add("manager_disk_total_bytes", disk.totalBytes);
      }
      return output.text();
    },
    async close() {
      stopping = true;
      await running;
    },
  };
}
