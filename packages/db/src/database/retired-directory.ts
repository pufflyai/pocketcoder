import { lstatSync } from "node:fs";
import { join } from "node:path";

export function assertActiveDirectory(directory: string) {
  try {
    lstatSync(join(directory, "RETIRED"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Any marker keeps admission closed, even if publication or storage was interrupted.
  throw new Error("This source installation is retired. Continue recovery in its destination.");
}
