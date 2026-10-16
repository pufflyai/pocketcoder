import { chmodSync, chownSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function prepareStorage(input: { uid: number; gid: number; targets: string[] }) {
  for (const target of input.targets) {
    const path = resolve(target);
    const protectedRoot = "/run/pocketcoder/inputs";
    if (
      path === "/" ||
      path === protectedRoot ||
      path.startsWith(`${protectedRoot}/`) ||
      protectedRoot.startsWith(`${path}/`)
    )
      throw new Error("Input projections are owned by the controller and cannot be initialized as writable storage.");
    if (!lstatSync(target).isDirectory() || readdirSync(target).length)
      throw new Error("Storage initialization requires an empty directory.");
    // Kubernetes fsGroup sets setgid. Clear it before children inherit archive-forbidden mode bits.
    chownSync(target, input.uid, input.gid);
    chmodSync(target, 0o700);
  }
}
