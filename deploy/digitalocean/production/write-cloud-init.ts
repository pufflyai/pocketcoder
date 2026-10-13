import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { ObjectStorageConfigSchema, readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { operatorCloudInit } from "./cloud-init";

const image = z.string().regex(/^ghcr\.io\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/);
const path = z.string().refine(isAbsolute);
const Config = z.strictObject({
  artifact: z.strictObject({
    url: z.url().startsWith("https://"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  }),
  runtimeImage: image,
  controllerImage: image,
  runtimeClass: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  storageConfigFile: path,
  encryptionKeyFile: path,
  cloudCredentialFile: path,
});
async function privatePath(input: string) {
  const resolved = await realpath(input);
  if (resolved.includes(`${sep}.pstdio${sep}workspaces${sep}`))
    throw new Error("Keep deployment files outside repositories and workspaces.");
  let directory = resolved;
  while (dirname(directory) !== directory) {
    if (existsSync(join(directory, ".git")))
      throw new Error("Keep deployment files outside repositories and workspaces.");
    directory = dirname(directory);
  }
  return resolved;
}

const [input, output] = process.argv.slice(2);
if (!input || !output || !isAbsolute(output))
  throw new Error("Usage: write-cloud-init.ts PRIVATE_INPUT_JSON ABSOLUTE_PRIVATE_OUTPUT_PATH");
const config = Config.parse(JSON.parse((await readPrivateFile(await privatePath(input), 65_536)).toString()));
const credential = z
  .strictObject({ token: z.string().min(1), expiresAt: z.iso.datetime(), clusterId: z.uuid() })
  .parse(JSON.parse((await readPrivateFile(await privatePath(config.cloudCredentialFile), 65_536)).toString()));
if (Date.parse(credential.expiresAt) <= Date.now()) throw new Error("Cloud deployment authority has expired.");
const storage = ObjectStorageConfigSchema.parse(
  JSON.parse((await readPrivateFile(await privatePath(config.storageConfigFile), 65_536)).toString()),
);
const encryptionKey = await readPrivateFile(await privatePath(config.encryptionKeyFile), 32);
if (encryptionKey.length !== 32) throw new Error("Use the retained separate 32-byte archive key.");
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await privatePath(dirname(output));
if (((await stat(dirname(output))).mode & 0o777) !== 0o700) throw new Error("Use a mode-0700 operator directory.");
const content = operatorCloudInit({ ...config, cloudCredential: credential, storage, encryptionKey });
if (Buffer.byteLength(content) > 65_536) throw new Error("Operator startup configuration exceeds the provider limit.");
const temporary = `${output}.${randomUUID()}`;
await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
await rename(temporary, output);
console.log("Wrote private operator startup configuration. No SSH installation is required.");
