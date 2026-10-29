import type { Argv } from "yargs";

export function principalOutputOptions(command: Argv) {
  return command.option("json", { type: "boolean", default: false, description: "Print principal metadata as JSON" });
}

export function principalGrantOptions(command: Argv) {
  return principalOutputOptions(command)
    .option("scopes", { type: "string", description: "Comma-separated scopes" })
    .option("templates", { type: "string", description: "Comma-separated template names, or * for all templates" });
}
