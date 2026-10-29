import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applySecretValue, readSecretValue } from "@pstdio/pocketcoder-drivers";
import { syncPrivateDirectory } from "../private-files";
import type { SecretTarget } from "./principal-file";

async function readFileTarget(path: string) {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Write a fresh private file and rename it over the target, so readers never see a partial token.
async function writeFileTarget(path: string, value: string) {
  const staging = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  await rename(staging, path);
  syncPrivateDirectory(dirname(path));
}

export function secretTargetStore(target: SecretTarget) {
  if (target.kind === "file") {
    return {
      describe: () => `file ${target.path}`,
      read: () => readFileTarget(target.path),
      write: (value: string) => writeFileTarget(target.path, value),
    };
  }
  return {
    describe: () => `kubernetes-secret ${target.namespace}/${target.name}#${target.key}`,
    read: () => readSecretValue("kubectl", target),
    write: (value: string) => applySecretValue("kubectl", target, value),
  };
}

export type SecretTargetStore = ReturnType<typeof secretTargetStore>;
