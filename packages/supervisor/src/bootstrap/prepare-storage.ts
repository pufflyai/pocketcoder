import { chmodSync, chownSync, lstatSync, readdirSync } from "node:fs";

export function prepareStorage(input: { uid: number; gid: number; targets: string[] }) {
  for (const target of input.targets) {
    if (!lstatSync(target).isDirectory() || readdirSync(target).length)
      throw new Error("Storage initialization requires an empty directory.");
    // Kubernetes fsGroup sets setgid. Clear it before children inherit archive-forbidden mode bits.
    chownSync(target, input.uid, input.gid);
    chmodSync(target, 0o700);
  }
}
