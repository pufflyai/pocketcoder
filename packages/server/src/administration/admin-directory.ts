import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function openAdminDirectory(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const owned = fstatSync(descriptor);
  let closed = false;
  function validate() {
    const current = lstatSync(path);
    if (closed || !current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino)
      throw new Error("Local admin directory was replaced.");
    if ((current.mode & 0o777) !== 0o700) throw new Error("Local admin directory must have mode 0700.");
  }
  try {
    validate();
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return {
    path,
    validate,
    removeFile(name: "admin.sock") {
      validate();
      unlinkSync(join(path, name));
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  };
}
