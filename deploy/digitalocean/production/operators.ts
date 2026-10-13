import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagerStore } from "@pstdio/pocketcoder-manager/store";

export async function issueOperators(store: ManagerStore, directory: string, expiresAt: Date) {
  const tokens = {
    "schedule-operator-token": await store.createOperator(expiresAt),
    "metrics-operator-token": await store.createOperator(expiresAt, "metrics"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const [name, token] of Object.entries(tokens)) {
    const temporary = join(directory, `.${name}-${randomUUID()}`);
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, name));
  }
}
