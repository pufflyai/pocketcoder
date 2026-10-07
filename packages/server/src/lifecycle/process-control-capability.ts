// Reads one exact private process-local capability without following or adopting another file.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { privateDirectory, processControlPath } from "./process-control-path";

export async function readProcessCapability(root: string, instanceId: string, pid: number) {
  const paths = processControlPath(root, instanceId);
  await privateDirectory(root);
  await privateDirectory(paths.directory);
  const file = await open(paths.capabilityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const original = await file.stat();
    if (
      !original.isFile() ||
      original.uid !== process.getuid?.() ||
      (original.mode & 0o777) !== 0o600 ||
      original.size > 512
    )
      throw new Error("controller_control_file_unowned");
    const bytes = Buffer.alloc(513);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await file.read(bytes, offset, bytes.length - offset);
      if (!next.bytesRead) break;
      offset += next.bytesRead;
    }
    if (offset > 512) throw new Error("controller_control_file_too_large");
    const row = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    if (
      row.instanceId !== instanceId ||
      row.pid !== pid ||
      !Number.isInteger(row.port) ||
      row.port < 1 ||
      row.port > 65535 ||
      typeof row.capability !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.capability)
    )
      throw new Error("controller_control_target_invalid");
    return { url: `http://127.0.0.1:${row.port}`, authorization: `Bearer ${row.capability}` };
  } finally {
    await file.close();
  }
}
