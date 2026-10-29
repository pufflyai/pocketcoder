import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPathCheck } from "./canonical-path";

export function openDataDirectory(path: string, heldDescriptor?: number) {
  const directory = resolve(path);
  const descriptor =
    heldDescriptor ?? openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  const isCanonical = canonicalPathCheck(directory, directory, descriptor, (current) => {
    if (current.dev !== opened.dev || current.ino !== opened.ino)
      throw new Error("Data directory was replaced or redirected.");
    if ((current.mode & 0o777) !== 0o700) throw new Error("Data directory must have mode 0700.");
  });
  let closed = false;
  const validate = () => {
    if (closed) throw new Error("Data directory is closed.");
    if (!isCanonical()) throw new Error("Data directory was replaced or redirected.");
  };
  try {
    validate();
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return {
    path: directory,
    descriptor,
    validate,
    close() {
      if (!closed) {
        closed = true;
        closeSync(descriptor);
      }
    },
  };
}
