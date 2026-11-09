import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import type { Flags } from "../../command/cli-context";

export const sessionOption = (command: Argv) =>
  command.option("session", { type: "string", demandOption: true, description: "Logical session ID" });
// A stop command is retried with the same ID after a lost reply, so generate it once and print it.
export const cancelIdOf = (flags: Flags) =>
  typeof flags["cancel-id"] === "string" ? flags["cancel-id"] : randomUUID();
