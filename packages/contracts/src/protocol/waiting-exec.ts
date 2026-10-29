import type { LaunchMode } from "../persistence/persistence";
import { workloadLifecycle } from "../templates/workload-policy";
import { type WorkloadTemplateSnapshot, WorkloadTemplateSnapshotSchema } from "../templates/workload-template";
import { ExecSpecSchema } from "./protocol-exec";

// This renders trusted template commands only. It does not admit a profile or
// claim that the installed storage/adapter supports the rest of that profile.
export function waitingExecSpec(
  snapshot: WorkloadTemplateSnapshot,
  incarnationId: string,
  launchMode: LaunchMode,
  launchInput?: Record<string, unknown> | null,
) {
  const { manifest } = WorkloadTemplateSnapshotSchema.parse(snapshot);
  const spec = manifest.spec;
  const policy = workloadLifecycle(manifest);
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
    env: launchInput ? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(launchInput) } : {},
    services: spec.services,
    previews: spec.previews,
    timeouts: policy.timeouts,
    security: { writable_memory_paths: spec.security.writableMemoryPaths },
    network:
      spec.network.mode === "restricted"
        ? { mode: "restricted", proxy_url: "http://127.0.0.1:18080", health_url: "http://127.0.0.1:18082/healthz" }
        : { mode: "unrestricted" },
    launch_mode: launchMode,
    persistence: {
      mounts: policy.persistence.mounts.map(({ name, target }) => ({ name, target })),
      conversation_restore: policy.persistence.conversationRestore,
    },
    checkpoint_hook: policy.checkpointHook
      ? {
          command: policy.checkpointHook.command,
          timeout_seconds: policy.checkpointHook.timeoutSeconds,
          env: policy.checkpointHook.env,
          ...(policy.checkpointHook.cwd ? { cwd: policy.checkpointHook.cwd } : {}),
        }
      : null,
    outputs: {},
  });
}
