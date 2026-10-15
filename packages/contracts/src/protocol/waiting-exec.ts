import type { LaunchMode } from "../persistence/persistence";
import { type WorkloadTemplateSnapshot, WorkloadTemplateSnapshotSchema } from "../templates/workload-template";
import { ExecSpecSchema } from "./protocol-exec";

// This renders trusted template commands only. It does not admit a profile or
// claim that the installed storage/adapter supports the rest of that profile.
export function waitingExecSpec(snapshot: WorkloadTemplateSnapshot, incarnationId: string, launchMode: LaunchMode) {
  const { manifest } = WorkloadTemplateSnapshotSchema.parse(snapshot);
  const spec = manifest.spec;
  const operations = Object.fromEntries(
    Object.entries(spec.operations).flatMap(([name, operation]) => {
      const adapter = spec.adapters[operation.adapter];
      return adapter?.kind === "process" && adapter.command
        ? [[name, { command: adapter.command, cwd: adapter.cwd, env: adapter.env }]]
        : [];
    }),
  );
  return ExecSpecSchema.parse({
    harness: null,
    workload: {
      incarnationId,
      profile: spec.profile,
      operations,
      infrastructure: Object.fromEntries(
        Object.entries(spec.services).flatMap(([name, service]) => (service.process ? [[name, service.process]] : [])),
      ),
    },
    setup: [],
    env: {},
    services: spec.services,
    previews: spec.previews,
    timeouts: {
      start: `${spec.limits.deadlineSeconds}s`,
      idle: `${spec.limits.deadlineSeconds}s`,
      maxAge: `${spec.limits.deadlineSeconds}s`,
      disconnectGrace: `${spec.limits.deadlineSeconds}s`,
      terminateGrace: `${spec.limits.finalizationSeconds}s`,
    },
    security: { writable_memory_paths: spec.security.writableMemoryPaths },
    network:
      spec.network.mode === "restricted"
        ? { mode: "restricted", proxy_url: "http://127.0.0.1:18080", health_url: "http://127.0.0.1:18082/healthz" }
        : { mode: "unrestricted" },
    launch_mode: launchMode,
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  });
}
