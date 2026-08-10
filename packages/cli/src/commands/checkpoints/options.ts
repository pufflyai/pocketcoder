import type { Argv } from "yargs";

export function idOption(command: Argv) {
  return command.option("id", {
    type: "string",
    demandOption: true,
    description: "Checkpoint ID",
  });
}
