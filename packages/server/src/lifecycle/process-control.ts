// Serves finite process-owned localhost control without tenant-key authority.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { RunningPocketCoderServer } from "./controller-listener";
import { createControlDirectory, privateDirectory } from "./process-control-path";
import { controlRequest } from "./process-control-request";

function authorized(request: Request, capability: Buffer) {
  const header = request.headers.get("authorization");
  if (header?.length !== 71 || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "hex");
  return supplied.length === capability.length && timingSafeEqual(supplied, capability);
}

export async function startProcessControl(options: {
  running: RunningPocketCoderServer;
  root: string;
  instanceId: string;
}) {
  const paths = await createControlDirectory(options.root, options.instanceId, options.running.config);
  const capability = randomBytes(32);
  const requests = new Set<Promise<Response>>();
  let admitted = false;
  let stopped = false;
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 2,
    async fetch(request) {
      const work = (async () => {
        try {
          if (!authorized(request, capability)) throw new Error("controller_control_unowned");
          const { signal, deadline } = await controlRequest(request, options.instanceId);
          if (stopped || admitted) throw new Error("controller_control_attempt_exists");
          admitted = true;
          await options.running.quiesce(signal);
          signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error("controller_control_expired");
          return Response.json({ instanceId: options.instanceId, pid: process.pid, outcome: "userspace_quiescent" });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "controller_control_failed" },
            { status: 409 },
          );
        }
      })();
      requests.add(work);
      try {
        return await work;
      } finally {
        requests.delete(work);
      }
    },
  });
  const url = `http://127.0.0.1:${listener.port}`;
  let fileIdentity: Stats | undefined;
  const settle = async () => {
    stopped = true;
    // Descriptor settlement must precede every filesystem observation or cleanup.
    await listener.stop(true);
    await Promise.all(requests);
    const directory = await privateDirectory(paths.directory);
    if (directory.dev !== paths.directoryIdentity.dev || directory.ino !== paths.directoryIdentity.ino)
      throw new Error("controller_control_directory_changed");
    const current = await lstat(paths.capabilityPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current) {
      if (!fileIdentity || current.dev !== fileIdentity.dev || current.ino !== fileIdentity.ino || !current.isFile())
        throw new Error("controller_control_file_changed");
    }
    // A path can change after its identity read. Keep inert private originals;
    // this live transport owner cannot safely unlink a concurrently replaced path.
  };
  try {
    const file = await open(
      paths.capabilityPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fileIdentity = await file.stat();
      await file.writeFile(
        JSON.stringify({
          instanceId: options.instanceId,
          pid: process.pid,
          port: listener.port,
          capability: capability.toString("hex"),
        }),
      );
      if ((fileIdentity.mode & 0o777) !== 0o600 || fileIdentity.uid !== process.getuid?.())
        throw new Error("controller_control_file_unowned");
    } finally {
      await file.close();
    }
  } catch (error) {
    try {
      await settle();
    } catch (settlementError) {
      throw new AggregateError([error, settlementError], "controller_control_initialization_unsettled");
    }
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    url,
    capabilityPath: paths.capabilityPath,
    stop() {
      stopping ??= settle();
      return stopping;
    },
  };
}
