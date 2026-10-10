import { fsyncSync } from "node:fs";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { syncDirectory } from "./data-folder";

export class DurableFilesystem extends NodeFS {
  override async init(...[pg, options]: Parameters<NodeFS["init"]>) {
    const initialized = await super.init(pg, options);
    return {
      emscriptenOpts: {
        ...initialized.emscriptenOpts,
        preRun: [
          ...(initialized.emscriptenOpts.preRun ?? []),
          (module: {
            FS: {
              isDir(mode: number): boolean;
              filesystems: {
                NODEFS: {
                  realPath(node: unknown): string;
                  node_ops: {
                    mknod(parent: unknown, name: string, mode: number, device: number): unknown;
                    setattr(node: { mode: number }, attributes: { mode?: number }): void;
                  };
                  stream_ops: { fsync?: (stream: { nfd?: number; node: unknown }) => number };
                };
              };
            };
          }) => {
            const filesystem = module.FS.filesystems.NODEFS;
            const privateMode = (mode: number) => (mode & ~0o7777) | (module.FS.isDir(mode) ? 0o700 : 0o600);
            const create = filesystem.node_ops.mknod;
            const update = filesystem.node_ops.setattr;
            // PostgreSQL's generated catalog caches request broader modes than our private folder contract.
            filesystem.node_ops.mknod = (parent, name, mode, device) =>
              create.call(filesystem.node_ops, parent, name, privateMode(mode), device);
            filesystem.node_ops.setattr = (node, attributes) =>
              update.call(filesystem.node_ops, node, {
                ...attributes,
                ...(attributes.mode === undefined ? {} : { mode: privateMode(attributes.mode) }),
              });
            // Emscripten's NodeFS otherwise treats PostgreSQL fsync as a no-op.
            filesystem.stream_ops.fsync = (stream) => {
              if (stream.nfd === undefined) syncDirectory(module.FS.filesystems.NODEFS.realPath(stream.node));
              else fsyncSync(stream.nfd);
              return 0;
            };
          },
        ],
      },
    };
  }
}
