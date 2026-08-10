import { randomUUID } from "node:crypto";
import {
  type PocketCoderClient,
  TERMINAL_WORKSPACE_STATES,
  type WorkspaceSummary,
} from "@pstdio/pocketcoder-sdk";
import type { Argv } from "yargs";
import { controlPlaneClient, type Flags, fail } from "../../cli-context";
import { addAction } from "../command";
import { parseLaunchInput } from "./launch-input";

type CliFail = (message: string) => never;

interface WorkspaceCreateDeps {
  client: PocketCoderClient;
  fail: CliFail;
}

export function addCreateCommand(parser: Argv) {
  return addAction(
    parser,
    "create",
    "Create a workspace",
    (command) =>
      command
        .version(false)
        .option("template", {
          type: "string",
          demandOption: true,
          description: "Template name",
        })
        .option("version", { type: "string", description: "Template version" })
        .option("external-id", {
          type: "string",
          description: "Caller identity and idempotency key",
        })
        .option("input", { type: "string", description: "Launch input as a JSON object" })
        .option("source", {
          type: "string",
          description: "Template-declared repository alias",
        })
        .option("revision", {
          type: "string",
          description: "Allowed Git branch, tag, or commit",
        })
        .option("wait", {
          type: "boolean",
          description: "Wait until the workspace is ready or terminal",
        })
        .option("wait-timeout-seconds", {
          type: "number",
          default: 300,
          description: "Maximum time to wait for readiness",
        })
        .option("cancel-on-exit", {
          type: "boolean",
          description: "Cancel the workspace if waiting is interrupted",
        })
        .option("json", {
          type: "boolean",
          description: "Print only the final workspace resource as JSON",
        }),
    async (flags) => createWorkspace(flags, { client: controlPlaneClient(), fail }),
  );
}

function required(flags: Flags, key: string, failCommand: CliFail): string {
  const value = flags[key];
  if (typeof value !== "string" || value === "") failCommand(`missing required flag --${key}`);
  return value;
}

function waitTimeout(flags: Flags, failCommand: CliFail): number {
  const raw = flags["wait-timeout-seconds"];
  const value = typeof raw === "number" ? raw : raw === undefined ? 300 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1800) {
    failCommand("--wait-timeout-seconds must be an integer from 1 to 1800");
  }
  return value;
}

function failureMessage(workspace: WorkspaceSummary) {
  const reason = workspace.reason_code ?? workspace.failure?.reason_code ?? "no reason";
  const tail = workspace.failure?.log_tail.trim();
  return [
    `workspace ${workspace.id} reached ${workspace.state} (${reason})`,
    ...(tail ? [`failure log:\n${tail}`] : []),
  ].join("\n");
}

async function waitForReady(
  initial: WorkspaceSummary,
  flags: Flags,
  { client, fail: failCommand }: WorkspaceCreateDeps,
) {
  const timeoutSeconds = waitTimeout(flags, failCommand);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let workspace = initial;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    while (workspace.state !== "ready") {
      if (TERMINAL_WORKSPACE_STATES.has(workspace.state)) failCommand(failureMessage(workspace));
      if (interrupted) {
        if (flags["cancel-on-exit"] === true) await client.workspaces.cancel(workspace.id);
        console.error(
          `pcd: interrupted while waiting for workspace ${workspace.id}${flags["cancel-on-exit"] === true ? " (canceled)" : " (left running)"}`,
        );
        process.exit(130);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        failCommand(
          `workspace ${workspace.id} did not become ready within ${timeoutSeconds} seconds`,
        );
      }
      const change = await client.workspaces.change(
        workspace.id,
        workspace.change_cursor,
        Math.max(0, Math.min(30, Math.ceil(remainingMs / 1000))),
      );
      workspace = change.workspace;
    }
    return workspace;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function createWorkspace(flags: Flags, deps: WorkspaceCreateDeps) {
  const template = required(flags, "template", deps.fail);
  const externalId =
    typeof flags["external-id"] === "string" ? flags["external-id"] : `pcd-${randomUUID()}`;
  const launchInput = parseLaunchInput(flags.input, deps.fail);
  const created = await deps.client.workspaces.create({
    externalId,
    templateName: template,
    ...(typeof flags.version === "string" ? { templateVersion: flags.version } : {}),
    ...(launchInput ? { launchInput } : {}),
    ...(typeof flags.source === "string"
      ? {
          source: {
            kind: "git",
            repository: flags.source,
            revision: typeof flags.revision === "string" ? flags.revision : "main",
          },
        }
      : {}),
  });
  if (flags.wait !== true) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  if (flags.json !== true) {
    console.log(`workspace ${created.id} ${created.state}; waiting for ready`);
  }
  const ready = await waitForReady(created, flags, deps);
  if (flags.json === true) console.log(JSON.stringify(ready, null, 2));
  else console.log(`workspace ${ready.id} ready`);
}
