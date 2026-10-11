import { join } from "node:path";
import type { AccountPurgeIntent } from "@pstdio/pocketcoder-contracts";
import { AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import { readPrivateFile, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { AccountComputeSchema } from "./account-state";

const State = z.strictObject({
  intent: AccountPurgeIntentSchema,
  state: z.enum(["purging", "drained"]),
  keysRevokedAt: z.iso.datetime().optional(),
  compute: AccountComputeSchema.optional(),
});
export type PurgeState = z.infer<typeof State>;

export async function loadPurgeState(directory: string) {
  try {
    return State.parse(JSON.parse((await readPrivateFile(join(directory, "account-purge.json"), 65_536)).toString()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function validatePurgeState(state: PurgeState | undefined, intent: AccountPurgeIntent) {
  if (state && JSON.stringify(state.intent) !== JSON.stringify(intent))
    throw new Error("Private purge intent differs.");
}

export function savePurgeState(directory: string, state: PurgeState) {
  return writePrivateJson(join(directory, "account-purge.json"), State.parse(state), 65_536);
}
