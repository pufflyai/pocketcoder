import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function physicalPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(path))
    throw new Error("Unresolved filesystem link.");
  if (existsSync(path)) return realpathSync(path);
  return join(physicalPath(dirname(path)), basename(path));
}
export function overlaps(left: string, right: string) {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return contains(left, right) || contains(right, left);
}
export function privateRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) === sep || /[,\n\r]/.test(path))
    throw new Error("Input projection root must be an absolute private directory.");
  const root = physicalPath(resolve(path));
  if (root === sep) throw new Error("Input projection root must be a private directory.");
  return root;
}
export function inputId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new Error("Input projection IDs must be UUIDs.");
  return id;
}
export async function directory(path: string, mode = 0o700) {
  try {
    await assertDirectory(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await directory(dirname(path));
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(path);
  await syncDirectory(dirname(path));
}
export async function assertDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || physicalPath(path) !== resolve(path))
    throw new Error("Input projection directories must not contain links.");
}
export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
