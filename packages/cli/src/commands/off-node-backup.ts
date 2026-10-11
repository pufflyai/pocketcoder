import { resolve } from "node:path";
import {
  loadOffNodeConfig,
  OffNodeBackupReceiptSchema,
  readPrivateFile,
  restoreOffNodeBackup,
} from "@pstdio/pocketcoder-db/off-node";
import type { Argv } from "yargs";
import { need } from "../command/cli-context";
import { requestLocalAdministration } from "../command/local-admin";
import { addAction } from "./command";

export function addOffNodeBackupCommands(commands: Argv) {
  addAction(
    commands,
    "create-off-node",
    "Capture an encrypted backup in the configured private object store",
    (command) =>
      command.option("dir", { type: "string" }).option("operation-id", { type: "string", demandOption: true }),
    async (flags) => {
      const result = await requestLocalAdministration(
        flags,
        "/v1/backup/off-node",
        { operation_id: need(flags, "operation-id") },
        null,
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );
  return addAction(
    commands,
    "restore-off-node <receipt>",
    "Restore encrypted data onto a fresh private volume after source compute is fenced",
    (command) =>
      command
        .positional("receipt", { type: "string", demandOption: true })
        .option("dir", { type: "string", demandOption: true })
        .option("journal-dir", { type: "string", demandOption: true })
        .option("checkpoint-dir", { type: "string", demandOption: true })
        .option("off-node-config", { type: "string", demandOption: true })
        .option("operation-id", { type: "string", demandOption: true }),
    async (flags) => {
      const dataDir = resolve(need(flags, "dir"));
      const offNode = await loadOffNodeConfig(resolve(need(flags, "off-node-config")), dataDir);
      const receipt = OffNodeBackupReceiptSchema.parse(
        JSON.parse((await readPrivateFile(resolve(need(flags, "receipt")), 65_536)).toString()),
      );
      const result = await restoreOffNodeBackup({
        operationId: need(flags, "operation-id"),
        receipt,
        offNode,
        dataDir,
        journalDir: resolve(need(flags, "journal-dir")),
        checkpointDir: resolve(need(flags, "checkpoint-dir")),
      });
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
