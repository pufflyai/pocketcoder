import type { Argv } from "yargs";

export function idOption(command: Argv) {
  return command.option("id", {
    type: "string",
    demandOption: true,
    description: "Workspace ID",
  });
}

export function paginationOptions(command: Argv) {
  return idOption(command)
    .option("cursor", {
      type: "string",
      description: "Continue from an opaque pagination cursor",
    })
    .option("limit", { type: "string", description: "Maximum number of records" });
}

export function attachOptions(command: Argv) {
  return idOption(command)
    .option("after", { type: "string" })
    .option("message", { type: "string" })
    .option("file", {
      type: "string",
      array: true,
      description: "Local file to upload as an attachment (repeatable, requires --message)",
    })
    .option("json", { type: "boolean" });
}

export function pagination(flags: Record<string, unknown>) {
  return {
    ...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}),
    ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
  };
}
