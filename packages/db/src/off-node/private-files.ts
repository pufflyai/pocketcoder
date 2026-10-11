import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory } from "../database/data-folder";

export async function readPrivateFile(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > maxBytes)
      throw new Error("Off-node credentials and receipts must be private files.");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export class PrivateFileLimitError extends Error {
  constructor() {
    super("Off-node metadata exceeds its private file limit.");
  }
}
export function requirePrivateJsonCapacity(value: unknown, maxBytes: number) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new PrivateFileLimitError();
  return text;
}

export async function writePrivateJson(path: string, value: unknown, maxBytes = Number.MAX_SAFE_INTEGER) {
  const text = requirePrivateJsonCapacity(value, maxBytes);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stage = `${path}.tmp`;
  const file = await open(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(stage, path);
  syncDirectory(directory);
}
