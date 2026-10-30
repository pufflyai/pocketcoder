import {
  ApiError,
  type CheckpointManifest,
  isAgentApiNative,
  type TemplateSnapshot,
} from "@pstdio/pocketcoder-contracts";
import type { TemplateStore, WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";

import { templateSnapshotOf } from "../workspaces/service";

export type UpgradeIncompatibility = "session_format" | "persistence_mounts" | "file_ownership" | "checkpoint_manifest";

// AgentAPI reads its saved session from this path, so moving it loses the conversation.
function agentStateFile(snapshot: TemplateSnapshot) {
  return isAgentApiNative(snapshot.spec) ? snapshot.spec.agent.stateFile : undefined;
}

// A restore copies the saved files unchanged into the target's mounts. The target must
// read the same session format from the same paths, as the same user, and its limits
// must still fit everything the source template allowed. Anything else needs a data
// migration, which an upgrade does not do.
export function upgradeIncompatibility(
  source: TemplateSnapshot,
  target: TemplateSnapshot,
  manifest: CheckpointManifest | null,
): UpgradeIncompatibility | null {
  const from = source.spec.persistence;
  const to = target.spec.persistence;
  if (
    from.conversationRestore !== to.conversationRestore ||
    from.sessionCompatibility !== to.sessionCompatibility ||
    agentStateFile(source) !== agentStateFile(target)
  )
    return "session_format";
  const mountsFit =
    from.mounts.length === to.mounts.length &&
    from.mounts.every((mount, index) => {
      const next = to.mounts[index];
      return (
        next?.name === mount.name &&
        next.target === mount.target &&
        next.maxBytes >= mount.maxBytes &&
        next.maxFiles >= mount.maxFiles
      );
    });
  if (!mountsFit) return "persistence_mounts";
  if (source.spec.security.uid !== target.spec.security.uid || source.spec.security.gid !== target.spec.security.gid)
    return "file_ownership";
  if (
    manifest &&
    (manifest.template_digest !== source.digest ||
      manifest.mounts.map((mount) => mount.name).join("/") !== to.mounts.map((mount) => mount.name).join("/"))
  )
    return "checkpoint_manifest";
  return null;
}

// Resolves the requested version once, before any operation is recorded, so a rejected
// upgrade leaves the source workspace and its checkpoint untouched.
export async function resolveUpgradeTarget(store: TemplateStore, checkpoint: WorkspaceCheckpointRow, version: string) {
  const name = checkpoint.templateSnapshot.name;
  const template = await store.getTemplate(name, version);
  if (!template || template.status === "retired") {
    throw new ApiError("template.version_not_found", `Template ${name} has no usable version ${version}.`);
  }
  const snapshot = templateSnapshotOf(template);
  const reason = upgradeIncompatibility(checkpoint.templateSnapshot, snapshot, checkpoint.manifest);
  if (reason) {
    throw new ApiError("restore.incompatible", `Template ${name}@${version} cannot restore this checkpoint.`, {
      reason,
      checkpoint_id: checkpoint.id,
      template_version: version,
    });
  }
  return { template, snapshot };
}
