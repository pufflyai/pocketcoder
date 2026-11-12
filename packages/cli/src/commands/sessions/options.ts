import type { Argv } from "yargs";
export const sessionOption = (command: Argv) =>
  command.option("session", { type: "string", demandOption: true, description: "Logical session ID" });
