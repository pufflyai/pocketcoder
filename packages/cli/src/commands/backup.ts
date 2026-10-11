import { resolve } from "node:path";
import { restoreBackup, verifyBackup } from "@pstdio/pocketcoder-db/backup";
import type { Argv } from "yargs";
import { need } from "../command/cli-context";
import { requestLocalAdministration } from "../command/local-admin";
import { addAction, addResource } from "./command";
import { addOffNodeBackupCommands } from "./off-node-backup";

export function addBackupCommands(parser: Argv) {
  return addResource(parser, "backup", "Create, check and restore controller backups", (commands) => {
    addOffNodeBackupCommands(commands);
    addAction(
      commands,
      "create",
      "Write a private backup archive of the running controller",
      (command) =>
        command
          .option("out", {
            type: "string",
            demandOption: true,
            description: "New archive path outside the data folder",
          })
          .option("dir", { type: "string", description: "Data folder of the running server" })
          .option("timeout", {
            type: "number",
            default: 30,
            description: "Seconds to wait for writes to settle and the database to be copied",
          }),
      async (flags) => {
        const timeout = Number(flags.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0)
          throw new Error("--timeout must be a positive number of seconds.");
        const receipt = await requestLocalAdministration(
          flags,
          "/v1/backup",
          { output: resolve(need(flags, "out")), timeout_ms: Math.round(timeout * 1000) },
          null,
        );
        console.log(JSON.stringify(receipt, null, 2));
      },
    );
    addAction(
      commands,
      "restore <file>",
      "Restore a backup into a new data folder that starts in recovery",
      (command) =>
        command
          .positional("file", { type: "string", demandOption: true })
          .option("dir", { type: "string", demandOption: true, description: "New data folder; it must not exist" })
          .option("checkpoint-dir", {
            type: "string",
            description: "Empty folder for restored checkpoint archives (default: POCKETCODER_CHECKPOINT_DIR)",
          }),
      async (flags) => {
        const checkpointDir = flags["checkpoint-dir"] ?? process.env.POCKETCODER_CHECKPOINT_DIR;
        const restored = await restoreBackup({
          archive: resolve(need(flags, "file")),
          dataDir: resolve(need(flags, "dir")),
          ...(typeof checkpointDir === "string" ? { checkpointDir: resolve(checkpointDir) } : {}),
        });
        console.log(
          JSON.stringify(
            {
              directory: restored.directory,
              recovery_id: restored.recovery.recoveryId,
              snapshot_id: restored.recovery.snapshotId,
              journal: restored.recovery.journal,
              checkpoints: restored.checkpoints,
              next: "Start pocketcoder serve on this folder, then run pocketcoder recovery complete.",
            },
            null,
            2,
          ),
        );
      },
    );
    return addAction(
      commands,
      "verify <file>",
      "Check a backup archive without the data folder or a running server",
      (command) => command.positional("file", { type: "string", demandOption: true }),
      async (flags) => {
        const { manifest, bytes } = await verifyBackup(resolve(need(flags, "file")));
        console.log(
          JSON.stringify(
            {
              ok: true,
              bytes,
              snapshot_id: manifest.snapshotId,
              created_at: manifest.createdAt,
              position: manifest.database.position,
              checkpoints: manifest.checkpoints.length,
            },
            null,
            2,
          ),
        );
      },
    );
  });
}
