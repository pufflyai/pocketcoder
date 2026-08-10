import type { WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";

type WorkspaceSpec = WorkspaceLaunch["workspace"]["templateSnapshot"]["spec"];

export function appendWorkspaceMounts(args: string[], launch: WorkspaceLaunch): void {
  for (const mount of launch.mounts) {
    if (mount.source.kind !== "host-path") {
      throw new Error(
        `docker driver cannot consume ${mount.source.kind} storage; configure a host-path storage backend`,
      );
    }
    args.push(
      "--mount",
      `type=bind,src=${mount.source.path},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    );
  }
  for (const secret of launch.secrets) {
    if (secret.source.kind !== "host-path") {
      throw new Error(
        `docker driver cannot consume ${secret.source.kind} secrets; configure a file secret resolver`,
      );
    }
    args.push("--mount", `type=bind,src=${secret.source.path},dst=${secret.target},readonly`);
  }
}

export function appendSecurityOptions(args: string[], spec: WorkspaceSpec): void {
  for (const cap of spec.security.dropCapabilities) args.push("--cap-drop", cap);
  if (spec.security.readOnlyRoot) args.push("--read-only");
  for (const path of spec.security.writableMemoryPaths) {
    args.push(
      "--tmpfs",
      `${path}:rw,noexec,nosuid,size=256m,uid=${spec.security.uid},gid=${spec.security.gid},mode=0700`,
    );
  }
}
