import type { Argv } from "yargs";
import { addAction, unchanged } from "../command";
import { printStorageInventory } from "./inventory";

export function addDoctorCommand(parser: Argv) {
  return addAction(
    parser,
    "doctor",
    "Check the configured storage backend and inventory",
    unchanged,
    async () => printStorageInventory(true, false),
  );
}
