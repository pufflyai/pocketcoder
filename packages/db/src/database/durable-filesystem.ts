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
              filesystems: {
                NODEFS: {
                  realPath(node: unknown): string;
                  stream_ops: { fsync?: (stream: { nfd?: number; node: unknown }) => number };
                };
              };
            };
          }) => {
            // Emscripten's NodeFS otherwise treats PostgreSQL fsync as a no-op.
            module.FS.filesystems.NODEFS.stream_ops.fsync = (stream) => {
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
