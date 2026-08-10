import { isWorkspaceState, type WorkspaceState } from "@pstdio/pocketcoder-contracts";
import {
  TERMINAL_WORKSPACE_STATES,
  type WorkspaceListQuery,
  type WorkspaceSummary,
} from "@pstdio/pocketcoder-sdk";
import type { Argv } from "yargs";
import { controlPlaneClient, type Flags, fail } from "../../cli-context";
import { addAction } from "../command";

function stateFilter(flags: Flags): WorkspaceState | undefined {
  if (typeof flags.state !== "string") return undefined;
  if (!isWorkspaceState(flags.state)) fail(`unknown workspace state: ${flags.state}`);
  return flags.state;
}

function listFilters(flags: Flags): WorkspaceListQuery {
  return {
    state: stateFilter(flags),
    ...(typeof flags.template === "string" ? { template: flags.template } : {}),
    ...(typeof flags["external-id"] === "string" ? { externalId: flags["external-id"] } : {}),
    ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
  };
}

function printWorkspaces(items: WorkspaceSummary[]) {
  for (const item of items) {
    console.log(
      `${item.id}\t${item.state}${item.reason_code ? ` (${item.reason_code})` : ""}\t${item.template.name}@${item.template.version}\t${item.external_id}`,
    );
  }
  if (items.length === 0) console.log("(no workspaces)");
}

async function listWorkspaces(flags: Flags) {
  let items = (await controlPlaneClient().workspaces.list(listFilters(flags))).items;
  if (flags.active) {
    items = items.filter((item) => !TERMINAL_WORKSPACE_STATES.has(item.state));
  }
  if (flags.json) console.log(JSON.stringify(items, null, 2));
  else printWorkspaces(items);
}

export function addListCommand(parser: Argv) {
  return addAction(
    parser,
    "list",
    "List workspaces",
    (command) =>
      command
        .option("active", { type: "boolean", description: "Only show nonterminal workspaces" })
        .option("state", { type: "string", description: "Filter by state" })
        .option("template", { type: "string", description: "Filter by template name" })
        .option("external-id", { type: "string", description: "Filter by external ID" })
        .option("limit", { type: "string", description: "Maximum number of workspaces" })
        .option("json", { type: "boolean", description: "Print JSON" }),
    listWorkspaces,
  );
}
