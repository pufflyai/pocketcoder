import { chmodSync, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { openAdminDirectory } from "./admin-directory";

export async function startAdminSocket(directory: string, handle: (request: Request) => Response | Promise<Response>) {
  const parent = openAdminDirectory(realpathSync(directory));
  const path = join(parent.path, "admin.sock");
  const active = new Set<Promise<Response>>();
  let accepting = true;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let owned: Stats | undefined;
  function assertOwned() {
    parent.validate();
    const current = existsSync(path) ? lstatSync(path) : undefined;
    if (!owned || !current?.isSocket() || current.dev !== owned.dev || current.ino !== owned.ino)
      throw new Error("Local admin socket was replaced.");
  }
  try {
    if (existsSync(path)) {
      if (!lstatSync(path).isSocket()) throw new Error(`admin path is not a socket: ${path}`);
      parent.removeFile("admin.sock");
    }
    server = Bun.serve({
      unix: path,
      async fetch(request) {
        const work = (async () => {
          parent.validate();
          if (!accepting || active.size >= 16) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
              { error: { code: "maintenance.active", message: "Local administration is busy." } },
              { status: 503 },
            );
          }
          return handle(request);
        })();
        active.add(work);
        try {
          return await work;
        } finally {
          active.delete(work);
        }
      },
    });
    owned = lstatSync(path);
    assertOwned();
    chmodSync(path, 0o600);
    assertOwned();
    let stopped: Promise<void> | undefined;
    return {
      path,
      stop() {
        if (stopped) return stopped;
        try {
          // Bun unlinks its configured path itself. Refuse before calling stop
          // so a foreign socket survives and the original shutdown can retry.
          assertOwned();
        } catch (error) {
          return Promise.reject(error);
        }
        stopped = (async () => {
          accepting = false;
          try {
            await server?.stop(true);
            await Promise.allSettled([...active]);
            parent.validate();
            if (existsSync(path)) {
              const current = lstatSync(path);
              if (!current.isSocket() || current.dev !== owned?.dev || current.ino !== owned?.ino)
                throw new Error("Local admin socket was replaced.");
              parent.removeFile("admin.sock");
            }
          } finally {
            parent.close();
          }
        })();
        return stopped;
      },
    };
  } catch (error) {
    if (server) {
      assertOwned();
      await server.stop(true);
      await Promise.allSettled([...active]);
    }
    parent.close();
    throw error;
  }
}
