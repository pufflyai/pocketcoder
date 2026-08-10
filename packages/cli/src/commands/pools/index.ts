import type { Argv } from "yargs";
import { addResource } from "../command";
import { addListCommand } from "./list";

export function addPoolCommands(parser: Argv) {
  return addResource(parser, "pools", "Inspect operator-managed warm capacity", addListCommand);
}
