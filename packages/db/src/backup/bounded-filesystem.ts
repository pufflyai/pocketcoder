import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { NodeFS } from "@electric-sql/pglite/nodefs";

export interface DatabaseBudget {
  bytes: number;
  files: number;
}
type Node = { mode: number };
type Entry = { size: number };
type Stream = { node: Node; nfd: number; shared: { refcount: number } };
interface BudgetModule {
  FS: {
    isDir(mode: number): boolean;
    ErrnoError: new (errno: number) => Error;
    filesystems: {
      NODEFS: {
        realPath(node: Node): string;
        node_ops: {
          mknod(parent: Node, name: string, mode: number, device: number): Node;
          setattr(node: Node, attributes: { size?: number; mode?: number }): void;
          unlink(parent: Node, name: string): void;
          rmdir(parent: Node, name: string): void;
          rename(node: Node, parent: Node, name: string): void;
          symlink(parent: Node, name: string, target: string): void;
        };
        stream_ops: {
          open(stream: Stream): void;
          close(stream: Stream): void;
          write(stream: Stream, buffer: Uint8Array, offset: number, length: number, position: number): number;
        };
      };
    };
  };
}

// Guard the real NODEFS mutations before they consume the admitted bytes or inodes.
export function boundedFilesystem(filesystem: NodeFS, directory: string, budget?: DatabaseBudget) {
  if (!budget) return filesystem;
  const initialize = filesystem.init.bind(filesystem);
  filesystem.init = async (...args) => {
    const initialized = await initialize(...args);
    return {
      emscriptenOpts: {
        ...initialized.emscriptenOpts,
        preRun: [
          ...(initialized.emscriptenOpts.preRun ?? []),
          (mod) => installBudget(mod as unknown as BudgetModule, directory, budget),
        ],
      },
    };
  };
  return filesystem;
}

function installBudget(module: BudgetModule, directory: string, budget: DatabaseBudget) {
  const block = statfsSync(directory).bsize;
  const sizes = new Map<string, Entry>();
  const descriptors = new Map<number, Entry>();
  const allocation = (bytes: number) => Math.ceil(bytes / block) * block + block;
  function collect(path: string) {
    const info = lstatSync(path);
    sizes.set(path, { size: allocation(info.size) });
    if (info.isDirectory()) for (const name of readdirSync(path)) collect(join(path, name));
    else if (!info.isFile()) throw new Error("Database staging contains a nonregular entry.");
  }
  collect(directory);
  let bytes = [...sizes.values()].reduce((sum, value) => sum + value.size, 0);
  let files = sizes.size;
  if (bytes > budget.bytes || files > budget.files) throw new Error("Database staging capacity is exhausted.");
  const nodefs = module.FS.filesystems.NODEFS;
  const nodes = nodefs.node_ops;
  const streams = nodefs.stream_ops;
  // These copies have no tablespace links; links would redirect writes outside the owned budget.
  nodes.symlink = () => {
    throw new module.FS.ErrnoError(2);
  };
  function charge<T>(growth: number, inodes: number, mutate: () => T) {
    if (bytes + growth > budget.bytes || files + inodes > budget.files) throw new module.FS.ErrnoError(51);
    const result = mutate();
    // Keep removed/truncated space charged until close, including an unlinked file with a live descriptor.
    bytes += growth;
    files += inodes;
    return result;
  }
  function resize<T>(entry: Entry, size: number, mutate: () => T) {
    const next = Math.max(entry.size, size);
    const result = charge(next - entry.size, 0, mutate);
    entry.size = next;
    return result;
  }
  const create = nodes.mknod;
  nodes.mknod = (parent, name, mode, device) => {
    const path = join(nodefs.realPath(parent), name);
    const entry = { size: module.FS.isDir(mode) ? 2 * block : block };
    const result = charge(entry.size, 1, () => create.call(nodes, parent, name, mode, device));
    sizes.set(path, entry);
    return result;
  };
  const update = nodes.setattr;
  nodes.setattr = (node, attributes) => {
    if (attributes.size === undefined) return update.call(nodes, node, attributes);
    const path = nodefs.realPath(node);
    return resize(sizes.get(path) as Entry, allocation(attributes.size), () => update.call(nodes, node, attributes));
  };
  const open = streams.open;
  streams.open = (stream) => {
    open.call(streams, stream);
    if (stream.nfd !== undefined) descriptors.set(stream.nfd, sizes.get(nodefs.realPath(stream.node)) as Entry);
  };
  const close = streams.close;
  streams.close = (stream) => {
    close.call(streams, stream);
    if (stream.shared.refcount === 0) descriptors.delete(stream.nfd);
  };
  const write = streams.write;
  streams.write = (stream, buffer, offset, length, position) => {
    const entry = descriptors.get(stream.nfd) as Entry;
    return resize(entry, allocation(position + length), () =>
      write.call(streams, stream, buffer, offset, length, position),
    );
  };
  const unlink = nodes.unlink;
  nodes.unlink = (parent, name) => {
    unlink.call(nodes, parent, name);
    sizes.delete(join(nodefs.realPath(parent), name));
  };
  const rmdir = nodes.rmdir;
  nodes.rmdir = (parent, name) => {
    rmdir.call(nodes, parent, name);
    sizes.delete(join(nodefs.realPath(parent), name));
  };
  const rename = nodes.rename;
  nodes.rename = (node, parent, name) => {
    const from = nodefs.realPath(node);
    const to = join(nodefs.realPath(parent), name);
    const moving = [...sizes].filter(([path]) => path === from || path.startsWith(`${from}/`));
    rename.call(nodes, node, parent, name);
    for (const [path] of moving) sizes.delete(path);
    for (const [path, entry] of moving) sizes.set(to + path.slice(from.length), entry);
  };
}
