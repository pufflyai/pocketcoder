import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { safeCheckpointPath } from "@pstdio/pocketcoder-contracts";
import { canonicalPathCheck } from "../database/canonical-path";
import { createNativeDirectory } from "./native-directory";

export function openCheckpointDirectory(path: string, check: () => void) {
  const canonical = resolve(path);
  const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let transferred = false;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const isCanonical = canonicalPathCheck(canonical, canonical, descriptor);
    let closed = false;
    const validateNative = () => {
      if (closed) throw new Error("Checkpoint directory is closed.");
      const current = fstatSync(descriptor, { bigint: true });
      if (
        !current.isDirectory() ||
        !isCanonical() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.size !== opened.size ||
        current.mode !== opened.mode ||
        current.nlink !== opened.nlink ||
        current.mtimeNs !== opened.mtimeNs ||
        current.ctimeNs !== opened.ctimeNs
      )
        throw new Error("Checkpoint directory custody changed.");
    };
    const validate = () => {
      if (closed) throw new Error("Checkpoint directory is closed.");
      check();
      validateNative();
    };
    validate();
    const native = createNativeDirectory(descriptor);
    // fdopendir now owns the descriptor; only closedir may release it.
    transferred = true;
    return {
      path: canonical,
      descriptor,
      validate,
      validateNative,
      read() {
        while (true) {
          validate();
          const name = native.read();
          validate();
          if (name === undefined) return undefined;
          if (name === "." || name === "..") continue;
          if (!safeCheckpointPath(name) || name.includes("/")) throw new Error("Unsafe checkpoint filename.");
          return name;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        native.close();
      },
    };
  } catch (error) {
    if (!transferred) closeSync(descriptor);
    throw error;
  }
}
