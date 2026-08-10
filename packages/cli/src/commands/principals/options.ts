import type { Argv } from "yargs";

export function principalOptions(command: Argv) {
  return command
    .option("name", { type: "string", demandOption: true, description: "Principal name" })
    .option("scopes", {
      type: "string",
      demandOption: true,
      description: "Comma-separated scopes",
    })
    .option("templates", {
      type: "string",
      description: "Comma-separated template names, or * for all templates",
    });
}
