import { constants } from "node:fs";
import { type FileHandle, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { syncPrivateDirectory } from "../bootstrap/private-files";

const Action = z.enum(["suspend", "resume"]);
const State = z.strictObject({
  state: z.enum(["ready", "suspending", "suspended", "resuming"]),
  current: z.strictObject({ id: z.uuid(), kind: Action }).nullable(),
  completed: z.array(z.strictObject({ id: z.uuid(), kind: Action })),
  compute: z
    .strictObject({
      workspaces: z.array(z.uuid()),
      warm: z.array(z.uuid()),
      evidence: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
});
export type AccountState = z.infer<typeof State>;

export async function accountState(directory: string) {
  const path = join(directory, "account-lifecycle.json");
  let state: AccountState = { state: "ready", current: null, completed: [] };
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (file) {
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("Account lifecycle state is not private");
      state = State.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  }
  return {
    get state() {
      return state;
    },
    async save(next: AccountState) {
      const stage = `${path}.tmp`;
      const file = await open(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(State.parse(next))}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(stage, path);
      syncPrivateDirectory(directory);
      state = next;
    },
  };
}
