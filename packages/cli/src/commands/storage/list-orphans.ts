import type { Argv } from "yargs";
import { addAction, unchanged } from "../command";
import { printStorageInventory } from "./inventory";

export function addListOrphansCommand(parser: Argv) {
  return addAction(
    parser,
    "list-orphans",
    "List physical objects with no durable metadata",
    unchanged,
    async () => printStorageInventory(false, true),
  );
}
