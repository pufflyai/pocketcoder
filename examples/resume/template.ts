import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";

export function resumeTemplate(image: string, idleSeconds: number) {
  // The Linux host must read AgentAPI's 0600 state file for checkpoints.
  // Docker Desktop translates ownership for macOS users below UID 1000.
  const uid = process.getuid?.() ?? 10001;
  const gid = process.getgid?.() ?? 10001;
  return parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "pi-resume", description: "Isolated Pi persistence and resume test" },
    spec: {
      version: "1.0.0",
      image,
      agent: {
        type: "custom",
        command: ["bun", "/opt/pi/persistent-pi.ts"],
        cwd: "/workspace",
        stateFile: "/state/agentapi.json",
      },
      env: { HOME: "/home/agent" },
      resources: { cpu: "2", memory: "2Gi" },
      timeouts: { start: "5m", idle: `${idleSeconds}s`, maxAge: "2h", terminateGrace: "15s" },
      security: {
        uid: uid >= 1000 ? uid : 10001,
        gid: gid >= 1000 ? gid : 10001,
        readOnlyRoot: true,
        writableMemoryPaths: ["/tmp", "/home/agent"],
      },
      persistence: {
        mounts: [
          { name: "worktree", target: "/workspace", maxBytes: 1073741824, maxFiles: 100000 },
          { name: "agent-state", target: "/state", maxBytes: 268435456, maxFiles: 10000 },
        ],
        conversationRestore: "supported",
        sessionCompatibility: "pi-0.83.0-agentapi-0.12.2",
        checkpoint: {
          onIdle: "preserve",
          onDeadline: "preserve",
          onCleanExit: "preserve",
          onFailure: "retain-for-recovery",
          retention: "2h",
        },
      },
    },
  }).manifest;
}
